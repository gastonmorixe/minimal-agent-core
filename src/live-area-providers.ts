/**
 * Periodic scheduler that drives plugin-contributed live-area slots.
 *
 * Each {@link ResolvedLiveAreaSlot} is invoked once at start (`tick=0`)
 * and then every `definition.refreshMs` thereafter. Per-invocation
 * timeouts (`definition.timeoutMs`) are enforced by an `AbortController`
 * so a slow producer can't pile up multiple in-flight calls; the
 * scheduler also skips a tick if the previous invocation hasn't
 * resolved yet.
 *
 * Results are aggregated by `position` (`"header"` → above input via
 * `setDecorationLines`, `"footer"` → below input via `setFooterLines`).
 * The aggregator only PUSHES when a slot's value changes, which paired
 * with the editor's shallow-compare in `setDecorationLines` /
 * `setFooterLines` keeps the live area free of repaint flicker at
 * steady state.
 *
 * @module live-area-providers
 */

import type { ResolvedLiveAreaSlot } from "./plugins/types.ts"

/** Sink the scheduler writes into. Mirrors the `ReplEditor` shape. */
export interface LiveAreaSink {
  setDecorationLines?(lines: string[]): void
  setFooterLines?(lines: string[]): void
}

/** Optional dependencies for testability. */
export interface LiveAreaSchedulerDeps {
  /** Diagnostic stream. Defaults to `process.stderr`. */
  stderr?: NodeJS.WriteStream
  /**
   * `setTimeout` injection for fake-timer tests. The scheduler
   * round-trips the returned handle through {@link clearTimeout}; it
   * never inspects the handle's runtime shape, so a fake clock is free
   * to return any sentinel (object, number, …).
   */
  setTimeout?: (cb: () => void, ms: number) => unknown
  /** `clearTimeout` injection paired with {@link setTimeout}. */
  clearTimeout?: (handle: unknown) => void
  /** Logger for transient errors. Defaults to writing to stderr. */
  logger?: (msg: string) => void
}

interface SlotState {
  slot: ResolvedLiveAreaSlot
  tick: number
  current: string | null
  inFlight: boolean
  /** Opaque handle from {@link LiveAreaSchedulerDeps.setTimeout}. */
  timer: unknown
  abort: AbortController | null
  warnedHeader: boolean
}

/**
 * Drives a fixed set of live-area slots until {@link stop} is called.
 *
 * One scheduler per REPL session. Construct after the editor has
 * `start()`ed (the sink methods don't require the editor be running,
 * but the visual effect depends on it).
 */
export class LiveAreaScheduler {
  private readonly slots: SlotState[]
  private readonly sink: LiveAreaSink
  private readonly setT: (cb: () => void, ms: number) => unknown
  private readonly clearT: (h: unknown) => void
  private readonly logger: (msg: string) => void
  private stopped = false

  constructor(slots: ResolvedLiveAreaSlot[], sink: LiveAreaSink, deps: LiveAreaSchedulerDeps = {}) {
    this.slots = slots.map((slot) => ({
      slot,
      tick: 0,
      current: null,
      inFlight: false,
      timer: null,
      abort: null,
      warnedHeader: false,
    }))
    this.sink = sink
    this.setT = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms))
    // The default branch narrows `h` back to a real Timeout via the
    // host-typed clearTimeout. Tests inject their own pair so the
    // shape is internally consistent (cast safely confined here).
    this.clearT =
      deps.clearTimeout ??
      ((h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]))
    const stderr = deps.stderr ?? process.stderr
    this.logger =
      deps.logger ??
      ((msg) => {
        try {
          stderr.write(`[live-area] ${msg}\n`)
        } catch {
          // best-effort
        }
      })
  }

  /** Kick off the first invocation of every slot. */
  start(): void {
    for (const s of this.slots) {
      this.fire(s)
    }
  }

  /** Cancel pending timers + abort in-flight invocations. Idempotent. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const s of this.slots) {
      if (s.timer) {
        this.clearT(s.timer)
        s.timer = null
      }
      if (s.abort) {
        try {
          s.abort.abort()
        } catch {
          // best-effort
        }
        s.abort = null
      }
    }
  }

  /** Snapshot of current values, indexed by slot id. Useful for tests. */
  snapshot(): Map<string, string | null> {
    const m = new Map<string, string | null>()
    for (const s of this.slots) m.set(s.slot.definition.id, s.current)
    return m
  }

  private fire(s: SlotState): void {
    if (this.stopped) return
    if (s.inFlight) {
      // Previous tick still running — skip rather than pile up.
      this.scheduleNext(s)
      return
    }
    s.inFlight = true
    const ac = new AbortController()
    s.abort = ac
    const timeoutMs = s.slot.definition.timeoutMs ?? 5000
    const timeoutHandle = this.setT(() => {
      try {
        ac.abort()
      } catch {
        // best-effort
      }
    }, timeoutMs)
    const tick = s.tick++
    const ctx = {
      packageDir: s.slot.packageDir,
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      abort: ac.signal,
      stderr: process.stderr,
      tick,
    }
    const handle = (next: string | null): void => {
      this.clearT(timeoutHandle)
      s.inFlight = false
      s.abort = null
      if (this.stopped) return
      if (next !== s.current) {
        s.current = next
        this.repaint()
      }
      this.scheduleNext(s)
    }
    Promise.resolve()
      .then(() => s.slot.invoke(ctx))
      .then(
        (out) => handle(out),
        (err) => {
          this.logger(
            `slot "${s.slot.pluginId}/${s.slot.definition.id}" failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
          handle(null)
        },
      )
  }

  private scheduleNext(s: SlotState): void {
    if (this.stopped) return
    const refreshMs = Math.max(1000, s.slot.definition.refreshMs ?? 60_000)
    s.timer = this.setT(() => {
      s.timer = null
      this.fire(s)
    }, refreshMs)
  }

  private repaint(): void {
    // Footer-only routing in this cut. `position: "header"` is accepted
    // by the manifest parser but the REPL reserves `setDecorationLines`
    // for the queued-message display; until we have a mediator that
    // merges plugin-header lines with queue lines, header slots fall
    // through to footer with a one-time warning per slot.
    const footer: string[] = []
    for (const s of this.slots) {
      const line = s.current
      if (line == null || line.length === 0) continue
      if ((s.slot.definition.position ?? "footer") === "header" && !s.warnedHeader) {
        this.logger(
          `slot "${s.slot.pluginId}/${s.slot.definition.id}" requested ` +
            `position="header"; rendered as footer until queue/decoration mediator lands`,
        )
        s.warnedHeader = true
      }
      footer.push(line)
    }
    if (this.sink.setFooterLines) this.sink.setFooterLines(footer)
  }
}

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

import type { EventBus } from "./plugins/event-bus.ts"
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
  /**
   * Plugin event bus. When provided, every slot whose definition
   * declares `refreshOn: [...]` gets a listener installed for each
   * named event; on emit, the scheduler off-cycle re-fires that slot
   * (subject to the in-flight skip — bursts don't pile up).
   *
   * Pass `undefined` (default) to disable event-driven refresh
   * entirely; slots fall back to timer-only behavior. Tests usually
   * inject a fresh `EventBus` so they can `.emit()` directly.
   */
  bus?: EventBus
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
  private readonly bus: EventBus | null
  /** Listener disposers (one per `(slot, event)` pair). Walked at `stop()`. */
  private readonly busDisposers: Array<() => void> = []
  private stopped = false

  constructor(slots: ResolvedLiveAreaSlot[], sink: LiveAreaSink, deps: LiveAreaSchedulerDeps = {}) {
    this.slots = slots.map((slot) => ({
      slot,
      tick: 0,
      // Reserve the row from t=0 with the manifest-declared placeholder
      // (if any) so the editor's live-area height never grows when the
      // first invoke resolves. See ManifestLiveAreaSlot.placeholder
      // and the bug-1 analysis in the WT-quota-live-area worktree.
      current: slot.definition.placeholder ?? null,
      inFlight: false,
      timer: null,
      abort: null,
      warnedHeader: false,
    }))
    this.sink = sink
    this.bus = deps.bus ?? null
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

  /**
   * Kick off the first invocation of every slot.
   *
   * Order matters: we paint the placeholder rows BEFORE any
   * `fire()` runs, so the editor's first repaint already has the
   * footer at its final height — no growth-and-jump when the first
   * tick resolves a moment later. Then we wire the optional
   * `refreshOn` event listeners and finally trigger the first
   * invocation per slot.
   */
  start(): void {
    this.repaint()
    this.subscribeRefreshOn()
    for (const s of this.slots) {
      this.fire(s)
    }
  }

  /**
   * Install a bus listener for every `(slot, event)` pair. Each
   * listener calls `fire(slot)` with the standard in-flight skip
   * semantics, so a burst of events while a previous tick is in
   * flight collapses to one (subsequent) refresh. Stored disposers
   * are walked at `stop()` to avoid leaking listeners across REPL
   * teardown.
   */
  private subscribeRefreshOn(): void {
    if (!this.bus) return
    for (const s of this.slots) {
      const events = s.slot.definition.refreshOn ?? []
      for (const evt of events) {
        const dispose = this.bus.on(evt, () => {
          if (this.stopped) return
          this.fire(s)
        })
        this.busDisposers.push(dispose)
      }
    }
  }

  /** Cancel pending timers + abort in-flight invocations. Idempotent. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const dispose of this.busDisposers) {
      try {
        dispose()
      } catch {
        // best-effort
      }
    }
    this.busDisposers.length = 0
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
      // null from the handler means "no fresh data this tick". We
      // hold on the placeholder rather than clearing the row — a
      // clear would shrink the live-area height by one row and
      // re-introduce the prompt-jump that the placeholder exists to
      // prevent. When no placeholder is configured this collapses to
      // the previous behavior (s.current = null → row disappears).
      const resolved = next ?? s.slot.definition.placeholder ?? null
      if (resolved !== s.current) {
        s.current = resolved
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

  /** Last value pushed to {@link sink.setFooterLines}; used for dedup. */
  private lastFooter: string[] = []

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
    // Dedup at the scheduler layer: skip the sink push when nothing
    // changed since the last paint. This keeps the initial
    // "no-placeholder, no-data" `start()` repaint quiet (otherwise
    // it would emit a no-op `setFooterLines([])` that complicates
    // tests and adds a sink-level repaint EditorController already
    // shallow-compares away).
    if (
      footer.length === this.lastFooter.length &&
      footer.every((l, i) => l === this.lastFooter[i])
    ) {
      return
    }
    this.lastFooter = footer.slice()
    if (this.sink.setFooterLines) this.sink.setFooterLines(footer)
  }
}

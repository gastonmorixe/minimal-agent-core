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
 * @module ui/status/live-area-scheduler
 */

import {
  getDecorationSuffix,
  setDecorationSuffix,
} from "@minimal-agent/plugin-api/utils/decoration-suffix"
import { getFooterTails, setFooterTail } from "@minimal-agent/plugin-api/utils/footer-tail"
import { displayWidth } from "@minimal-agent/plugin-api/utils/term-width"

import {
  createPluginLogger,
  type DiagnosticBus,
  Facility,
  getDiagnosticBus,
  Severity,
} from "../../../bus/diagnostic-bus.ts"
import { agentContextToEnv } from "../../../plugins/agent-context.ts"
import type { EventBus } from "../../../plugins/event-bus.ts"
import type { PluginHost } from "../../../plugins/host/capabilities.ts"
import type { AgentContext, ResolvedLiveAreaSlot } from "../../../plugins/types.ts"

/** Sink the scheduler writes into. Mirrors the `ReplEditor` shape. */
export interface LiveAreaSink {
  setDecorationLines?(lines: string[]): void
  setFooterLines?(lines: string[]): void
}

/** Optional dependencies for testability. */
export interface LiveAreaSchedulerDeps {
  /**
   * Diagnostic stream. Retained for backwards compatibility but
   * unused by the scheduler's own diagnostics (those go through
   * {@link LiveAreaSchedulerDeps.diagnosticBus}). Some legacy tests
   * still set it.
   *
   * @deprecated The scheduler no longer writes here. Slot handlers
   * receive their own `ctx.stderr` independently.
   */
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
  /**
   * Diagnostic bus for scheduler-emitted timeout / failure events.
   * Defaults to the process-wide singleton ({@link getDiagnosticBus}).
   * Tests can inject an isolated bus to assert on emitted events.
   */
  diagnosticBus?: DiagnosticBus
  /**
   * Backwards-compat logger override. When set, replaces the
   * structured `diagnosticBus.emit(...)` calls with a single-line
   * string write — the historical behaviour. Pre-bus tests use this
   * to assert against substring matches without touching the bus.
   * Production code leaves it undefined.
   *
   * @deprecated Prefer subscribing to {@link diagnosticBus}.
   */
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
  /**
   * Main-agent identity (session id, pid, model, version). Same value
   * as {@link PluginLoaderOptions.agent}; the agent constructs it once
   * at boot and passes the SAME frozen object to both the loader and
   * this scheduler so plugins see a consistent identity regardless of
   * dispatch path.
   *
   * When set, slot handler contexts gain `ctx.agent` and slot
   * subprocesses inherit the `MINIMAL_AGENT_*` env vars produced by
   * {@link agentContextToEnv}. Omit in legacy tests; back-compat
   * preserves the historical "env is just process.env" behaviour.
   */
  agent?: AgentContext
  /**
   * Resolver for a slot plugin's frozen capability host, keyed by plugin id
   * (the loader's `hostFor`). When provided, each slot's `ctx.host` is the
   * host built from THAT plugin's declared `capabilities` (deny-by-default:
   * `undefined` when the plugin declared none). Lets a live-area slot read
   * host data (e.g. `quota-status` via `ctx.host.sessionInfo`) without
   * importing `src/`. Omitted in tests that don't exercise the capability.
   */
  hostFor?: (pluginId: string) => PluginHost | undefined
}

interface SlotState {
  slot: ResolvedLiveAreaSlot
  tick: number
  current: string | null
  inFlight: boolean
  /** Opaque handle from {@link LiveAreaSchedulerDeps.setTimeout}. */
  timer: unknown
  abort: AbortController | null
  /**
   * `true` when the previous tick emitted a timeout or failure diag
   * event. The next successful tick emits a recovery notice (via
   * `emitRecovery`) so the {@link TuiDiagnosticSurface} can clear its
   * matching slot. Resets on success.
   */
  hadFailure: boolean
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
  private readonly diagnosticBus: DiagnosticBus
  private readonly legacyLogger: ((msg: string) => void) | null
  private readonly bus: EventBus | null
  private readonly agent: AgentContext | undefined
  private readonly hostFor: ((pluginId: string) => PluginHost | undefined) | undefined
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
      hadFailure: false,
    }))
    this.sink = sink
    this.bus = deps.bus ?? null
    this.setT = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms))
    // The default branch narrows `h` back to a real Timeout via the
    // host-typed clearTimeout. Tests inject their own pair so the
    // shape is internally consistent (cast safely confined here).
    this.clearT =
      deps.clearTimeout ?? ((h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]))
    this.diagnosticBus = deps.diagnosticBus ?? getDiagnosticBus()
    this.legacyLogger = deps.logger ?? null
    this.agent = deps.agent
    this.hostFor = deps.hostFor
  }

  // ---------- diagnostic emit helpers ------------------------------------
  //
  // When `legacyLogger` is set (test injection) we emit a single-line
  // string in the historical shape. Otherwise we publish a structured
  // {@link LogEvent} on the diagnostic bus. The string shape preserves
  // the substrings legacy tests assert on (`"timed out"`,
  // `"<pluginId>/<slotId>"`, `"failed:"`). Production wiring leaves
  // `legacyLogger` null so the bus handles fan-out to file + TUI surface.
  private emitTimeout(slotLabel: string, timeoutMs: number): void {
    if (this.legacyLogger) {
      this.legacyLogger(
        "slot " +
          JSON.stringify(slotLabel) +
          " timed out after " +
          timeoutMs +
          "ms (invoke did not resolve in time); releasing inFlight gate so subsequent ticks can run",
      )
      return
    }
    this.diagnosticBus.emit({
      ts: Date.now(),
      severity: Severity.Warning,
      facility: Facility.User,
      source: "live-area.timeout",
      message:
        'slot "' +
        slotLabel +
        '" timed out after ' +
        timeoutMs +
        "ms (invoke did not resolve in time)",
      structuredData: { slot: slotLabel, "timeout-ms": timeoutMs },
    })
  }

  private emitFailure(slotLabel: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    if (this.legacyLogger) {
      this.legacyLogger("slot " + JSON.stringify(slotLabel) + " failed: " + msg)
      return
    }
    this.diagnosticBus.emit({
      ts: Date.now(),
      severity: Severity.Error,
      facility: Facility.User,
      source: "live-area.handler-failed",
      message: 'slot "' + slotLabel + '" handler failed: ' + msg,
      structuredData: { slot: slotLabel, error: msg },
    })
  }

  private emitRecovery(slotLabel: string): void {
    // No legacy-logger equivalent — recoveries were never logged in the
    // old code. The TuiDiagnosticSurface uses this to clear the matching
    // warn/error slot when a previously-failing producer becomes
    // healthy again.
    if (this.legacyLogger) return
    this.diagnosticBus.emit({
      ts: Date.now(),
      severity: Severity.Notice,
      facility: Facility.User,
      // Source matches the failure sources so the TUI surface clears
      // both the timeout (warn) and handler-failed (error) slots in
      // one shot. The recovery flag tells the surface to clear, not
      // populate.
      source: "live-area.timeout",
      message: 'slot "' + slotLabel + '" producing values again',
      structuredData: { slot: slotLabel, recovery: "true" },
    })
    this.diagnosticBus.emit({
      ts: Date.now(),
      severity: Severity.Notice,
      facility: Facility.User,
      source: "live-area.handler-failed",
      message: 'slot "' + slotLabel + '" producing values again',
      structuredData: { slot: slotLabel, recovery: "true" },
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
    const tick = s.tick++
    const ctx = {
      packageDir: s.slot.packageDir,
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(this.agent ? agentContextToEnv(this.agent) : {}),
      } as Record<string, string>,
      abort: ac.signal,
      stderr: process.stderr,
      // Plugin-scoped logger auto-prefixes source with this slot's
      // plugin id. Slot handlers that emit `ctx.log.warn("api-fail", ...)`
      // get the emitted source `<pluginId>.api-fail` on the diag bus.
      log: createPluginLogger(s.slot.pluginId, this.diagnosticBus),
      tick,
      // Side-channel for periodic slots to fan out onto the shared bus
      // (e.g. `schedule` emits `prompt.inject` for due tasks). No-op when
      // the scheduler was built without a bus (back-compat tests).
      emit: (channel: string, payload?: unknown) => this.bus?.emit(channel, payload),
      agent: this.agent,
      // Capability host for THIS slot's plugin (deny-by-default: undefined
      // when the plugin declared no `capabilities`). Lets a slot read host
      // data via `ctx.host.*` without importing `src/`. See `hostFor` in
      // the loader (memoized per plugin id).
      host: this.hostFor?.(s.slot.pluginId),
      // Decoration-suffix seam: the host owns the singleton (read back in
      // `flushFooter` via `getDecorationSuffix`); the slot handler publishes
      // its badge through this function instead of importing the shared
      // module directly. Keeps the state host-side so a moved (external)
      // plugin never gets a divergent second copy of the holder.
      setDecorationSuffix: (suffix: string) => setDecorationSuffix(suffix),
      // Keyed footer-tail publisher: bound to THIS slot's plugin id so
      // concurrent plugins publish independent right-aligned segments
      // without clobbering each other. Two slots of the same plugin share
      // the key (last writer wins). See plugin-api/utils/footer-tail.
      setFooterTail: (text: string) => setFooterTail(s.slot.pluginId, text),
      // Cells the host will append AFTER this line's own content at flush
      // time (decoration suffix + joined tails, gaps included). Slots that
      // do their own width-aware compression (quota-status's bar ladder)
      // subtract this so they start shrinking when the FULL line stops
      // fitting — not only when the bare line overflows cols. Computed per
      // fire: a tail appearing mid-session re-renders with the new budget.
      footerReservedWidth: this.reservedWidth(),
    }

    // Single-fire latch shared between the timeout path and the
    // invoke-resolved path. Whichever path runs first wins. The
    // other becomes a silent no-op.
    //
    // Why this matters: a well-behaved invoke honors `ctx.abort`,
    // so the timeout's `ac.abort()` causes invoke to reject quickly
    // and `handle()` runs via the rejection branch — `inFlight` is
    // released through the normal path.
    //
    // But not every handler is well-behaved (or every transport
    // wired through to the signal). If invoke ignores the signal
    // entirely, the original code left `s.inFlight = true` forever:
    // both heartbeat ticks and `refreshOn` bus events would skip
    // on the `if (s.inFlight) return` guard. A single stuck
    // request — e.g. a probe to a TCP socket that died during
    // macOS sleep — would deadlock every refresh path until
    // restart.
    //
    // Defensive belt: after the timeout fires we wait one
    // microtask hop for a "natural" resolution to land (the abort
    // listener may have just resolved/rejected the invoke
    // promise), then if we still have not settled we force-clean
    // ourselves so the next tick / event can run.
    const slotLabel = s.slot.pluginId + "/" + s.slot.definition.id
    let settled = false
    const handle = (next: string | null): void => {
      if (settled) return
      settled = true
      this.clearT(timeoutHandle)
      s.inFlight = false
      s.abort = null
      if (this.stopped) return
      // Recovery: a successful tick (non-null result) after a streak
      // of failures clears the matching warn/error slot on the TUI
      // surface. We don't emit on null because null can mean "still
      // unhealthy, just falling back to placeholder" depending on
      // the slot semantics.
      if (next !== null && s.hadFailure) {
        s.hadFailure = false
        this.emitRecovery(slotLabel)
      }
      // null from the handler means "no fresh data this tick". We
      // hold on the placeholder rather than clearing the row — a
      // clear would shrink the live-area height by one row and
      // re-introduce the prompt-jump that the placeholder exists to
      // prevent. When no placeholder is configured this collapses to
      // the previous behavior (s.current = null → row disappears).
      const resolved = next ?? s.slot.definition.placeholder ?? null
      s.current = resolved
      // Always repaint. Tail-only slots (tps) return null every tick and
      // publish via `setFooterTail`; skipping when `resolved === current`
      // left the footer stale even though the registry changed. flushFooter
      // already dedups identical arrays, so unchanged slots stay cheap.
      this.repaint()
      this.scheduleNext(s)
    }

    const timeoutHandle = this.setT(() => {
      try {
        ac.abort()
      } catch {
        // best-effort
      }
      // Defer for a few microtask hops so an invoke that DOES honor
      // the signal gets to win the latch (its `(out) => handle(out)`
      // continuation runs ahead of this checker). If we still have
      // not settled by then, conclude invoke is hung and free the
      // gate ourselves.
      //
      // Why TWO hops, not one: when the .then chain is built as
      //   `Promise.resolve().then(() => invoke(ctx)).then(handle)`
      // the invoke callback returns a thenable, so the runtime
      // schedules an extra "adopt" microtask to link the inner
      // promise into the chain. Counting from `resolve(...)` inside
      // the abort listener: hop 1 propagates fulfillment from the
      // inner promise to the chained one. Hop 2 is when `handle()`
      // actually runs. A single-hop checker fires BETWEEN those two
      // and would force-clean with `null`, clobbering the
      // well-behaved handler's real value. Two hops is enough across
      // V8/JSC/SpiderMonkey microtask draining. The existing
      // "aborts a slow invocation" + "well-behaved handler still
      // wins the latch" tests pin the contract.
      // `void` marks the chain as intentionally fire-and-forget. The
      // body cannot throw (it only calls `this.logger` and `handle`,
      // both of which are designed to swallow errors).
      void Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => {
          if (settled) return
          this.emitTimeout(slotLabel, timeoutMs)
          s.hadFailure = true
          handle(null)
        })
    }, timeoutMs)

    Promise.resolve()
      .then(() => s.slot.invoke(ctx))
      .then(
        (out) => handle(out),
        (err) => {
          // Don't double-log when the latch already fired via
          // timeout (the timeout path already wrote a "timed out"
          // diagnostic and an extra "AbortError" line is just
          // noise).
          if (!settled) {
            this.emitFailure(slotLabel, err)
            s.hadFailure = true
          }
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

  /**
   * Display-width cells currently reserved by host-appended segments on a
   * single-line footer value. Mirrors {@link flushFooter}'s composition:
   * the decoration suffix appends to the FIRST footer line, the joined
   * tail block to the LAST. A one-line status row (quota-status) can be
   * both first AND last, so both reservations count against it.
   *
   * Each append contributes its own two-space gap + visible width (ANSI
   * escapes measure as 0 cells). Slots subtract this from their usable
   * budget so bars shrink as soon as the whole painted line would stop
   * fitting — see `LiveAreaHandlerContext.footerReservedWidth`.
   *
   * Returns 0 when nothing is reserved (no suffix, no tails) so callers
   * can treat the field as plain subtraction without undefined-guards.
   */
  private reservedWidth(): number {
    let w = 0
    const suffix = getDecorationSuffix()
    if (suffix.length > 0) w += 2 + displayWidth(suffix)
    const tails = getFooterTails()
    if (tails.length > 0) w += 2 + displayWidth(tails)
    return w
  }

  /** Last value pushed to {@link sink.setDecorationLines}; used for dedup. */
  private lastHeader: string[] = []
  /** Last value pushed to {@link sink.setFooterLines}; used for dedup. */
  private lastFooter: string[] = []

  private repaint(): void {
    const header: string[] = []
    const footer: string[] = []
    for (const s of this.slots) {
      const line = s.current
      if (line == null || line.length === 0) continue
      // A slot may return a MULTI-LINE value: one logical widget that paints
      // several rows (e.g. a sub-agent fleet panel — a header row plus one row
      // per running worker). Split on "\n" so each row becomes a distinct live
      // area line the editor counts toward height. A single-line value yields
      // exactly one element. The slot owns its own row budget (cap rows +
      // "+N more").
      const target = (s.slot.definition.position ?? "footer") === "header" ? header : footer
      for (const row of line.split("\n")) target.push(row)
    }

    this.flushHeader(header)
    this.flushFooter(footer)
  }

  private flushHeader(header: string[]): void {
    if (
      header.length === this.lastHeader.length &&
      header.every((l, i) => l === this.lastHeader[i])
    ) {
      return
    }
    this.lastHeader = header.slice()
    if (this.sink.setDecorationLines) this.sink.setDecorationLines(header)
  }

  private flushFooter(footer: string[]): void {
    // Append any plugin-contributed decoration suffix (e.g. LSP status)
    // to the first footer line so it shares the same row as the intercom
    // roster text.
    const suffix = getDecorationSuffix()
    const modified = suffix && footer.length > 0 ? [footer[0] + suffix, ...footer.slice(1)] : footer
    // Plugin-contributed tails (e.g. tps readout): append INLINE after the
    // LAST footer line's content, separated by two spaces — the same visual
    // grammar as the segments inside that line. No right-edge padding: the
    // editor clips overlong footer lines, which would truncate a padded
    // tail; inline keeps it visible and reads as part of the line.
    //
    // Why LAST: slot paint order follows manifest load order, and the
    // intercom roster is a footer slot too — it can sort before
    // quota-status. The user's mental model of "the status line" is the
    // bottom-most one (quota + context + model + sid), so tails ride there.
    const tails = getFooterTails()
    if (tails && modified.length > 0) {
      const last = modified.length - 1
      modified[last] = `${modified[last]!}  ${tails}`
    }
    if (
      modified.length === this.lastFooter.length &&
      modified.every((l, i) => l === this.lastFooter[i])
    ) {
      return
    }
    this.lastFooter = modified.slice()
    if (this.sink.setFooterLines) this.sink.setFooterLines(modified)
  }
}

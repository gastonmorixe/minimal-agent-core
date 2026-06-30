/**
 * TUI surface that renders the two most-recent diagnostic events
 * (warning + error/critical) as a compact 0-2 line footer summary.
 *
 * # Why two slots
 *
 * The full log lives in `~/.minimal-agent/logs/...` (parseable, RFC
 * 5424). The TUI is a glanceable summary — what's currently wrong and
 * how often. Two slots covers the common cases:
 *
 *  - Background warning storm (e.g. quota timeout) → one warn line.
 *  - Distinct error (auth invalid_grant) → one error line.
 *  - Both at once → both lines, warn first.
 *
 * # Dedup rule
 *
 * Per slot, identical `(severity, source, message)` tuples increment
 * the slot's count instead of replacing it. Different tuples replace,
 * counter resets to 1.
 *
 * # Recovery semantics
 *
 * A `Notice` event with `structuredData.recovery === "true"` from the
 * same `source` clears the matching slot. Producers signal recovery
 * explicitly:
 *
 *     diag.notice("auth.refresh", "token rotated cleanly", \{ recovery: "true" \})
 *
 * Plain notices (without the flag) and Info/Debug are ignored — they
 * land in the file log but not in the UI.
 *
 * # Rendering
 *
 * Single line per slot, styled inline (no `c.*` import so this module
 * stays decoupled from `src/agent.ts`):
 *
 *   ⚠ <source>: <message>            (one warning, count 1)
 *   ⚠ <source>: <message> (×42)      (one warning, count above 1)
 *   ✗ <source>: <message>            (one error, count 1)
 *
 * Both lines:
 *
 *   ⚠ <source>: <message> (×3)
 *   ✗ <source>: <message>
 *
 * Hot path: each event runs through `onEvent()` and triggers exactly
 * one `setDiagnosticLines(...)` repaint. The downstream sink does
 * shallow-compare dedup so no-op repaints are cheap.
 *
 * @module ui/status/diagnostic-surface
 */

import { type DiagnosticBus, type LogEvent, Severity } from "../../../diagnostic-bus.ts"
import { c } from "../style/ansi.ts"

/**
 * Sink interface for receiving 0..2 styled diagnostic lines. Wired up
 * by `FooterAggregator` (`src/ui/status/footer-aggregator.ts`); production
 * code does not consume this directly.
 */
export interface DiagnosticLinesSink {
  setDiagnosticLines(lines: string[]): void
}

interface Slot {
  event: LogEvent | null
  count: number
}

/**
 * Renders the most recent warn and error diagnostics as at most two compact
 * footer lines for the TUI. Keeps one slot per severity with a repeat
 * counter (so floods show `xN` instead of scrolling), and pushes re-rendered
 * lines into the attached {@link DiagnosticLinesSink} on every bus event.
 */
export class TuiDiagnosticSurface {
  private warn: Slot = { event: null, count: 0 }
  private error: Slot = { event: null, count: 0 }
  private sink: DiagnosticLinesSink | null = null
  private disposeFn: (() => void) | null = null

  // No explicit constructor today. A `SurfaceOptions` shape (with
  // `now?: () => number` for an "ago" suffix on the dedup line) lived
  // here briefly but was retired alongside the empty constructor to
  // satisfy `no-useless-constructor`. Re-introduce both together when
  // the "ago" feature lands.

  /** Subscribe to a bus. Idempotent. */
  attach(bus: DiagnosticBus): void {
    if (this.disposeFn) return
    this.disposeFn = bus.on("*", (e) => this.onEvent(e))
  }

  /** Unsubscribe. Idempotent. */
  detach(): void {
    this.disposeFn?.()
    this.disposeFn = null
  }

  /**
   * Bind a sink. The surface immediately paints its current state via
   * `sink.setDiagnosticLines(...)`. Rebinding mid-life is supported;
   * the new sink receives the latest state synchronously.
   */
  bindSink(sink: DiagnosticLinesSink): void {
    this.sink = sink
    this.repaint()
  }

  /** Clear both slots. Triggers a repaint to `[]`. */
  clear(): void {
    this.warn = { event: null, count: 0 }
    this.error = { event: null, count: 0 }
    this.repaint()
  }

  /** Snapshot for tests / future "show me a backlog" features. */
  snapshot(): {
    warn: { event: LogEvent | null; count: number }
    error: { event: LogEvent | null; count: number }
  } {
    return {
      warn: { event: this.warn.event, count: this.warn.count },
      error: { event: this.error.event, count: this.error.count },
    }
  }

  /**
   * Direct event injection. The bus-attach path also routes here.
   * Public for tests so they don't need to wire a bus.
   */
  onEvent(e: LogEvent): void {
    if (e.severity === Severity.Warning) {
      this.warn = bumpOrReplace(this.warn, e)
      this.repaint()
      return
    }
    if (e.severity <= Severity.Error) {
      // Error (3), Critical (2), Alert (1), Emergency (0) all go to
      // the error slot. Lower number = more severe per RFC 5424.
      this.error = bumpOrReplace(this.error, e)
      this.repaint()
      return
    }
    if (e.severity === Severity.Notice) {
      // Recovery semantic: clear matching slots for the same source.
      const isRecovery =
        e.structuredData?.recovery === "true" || e.structuredData?.recovery === true
      if (!isRecovery) return
      let changed = false
      if (this.warn.event?.source === e.source) {
        this.warn = { event: null, count: 0 }
        changed = true
      }
      if (this.error.event?.source === e.source) {
        this.error = { event: null, count: 0 }
        changed = true
      }
      if (changed) this.repaint()
      return
    }
    // Info / Debug are NOT surfaced in the TUI. File sink covers them.
  }

  private repaint(): void {
    if (!this.sink) return
    const lines: string[] = []
    if (this.warn.event) lines.push(renderLine("warn", this.warn.event, this.warn.count))
    if (this.error.event) lines.push(renderLine("error", this.error.event, this.error.count))
    this.sink.setDiagnosticLines(lines)
  }
}

function bumpOrReplace(slot: Slot, e: LogEvent): Slot {
  if (
    slot.event !== null &&
    slot.event.source === e.source &&
    slot.event.message === e.message &&
    slot.event.severity === e.severity
  ) {
    return { event: e, count: slot.count + 1 }
  }
  return { event: e, count: 1 }
}

function renderLine(kind: "warn" | "error", e: LogEvent, count: number): string {
  const icon = kind === "warn" ? c.gold("⚠") : c.red("✗")
  const src = c.faintWhite(e.source)
  const msg = e.message
  const suffix = count > 1 ? " " + c.dim(`(×${count})`) : ""
  return `${icon} ${src}: ${msg}${suffix}`
}

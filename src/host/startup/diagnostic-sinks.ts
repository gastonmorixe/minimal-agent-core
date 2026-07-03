/**
 * Diagnostic-sink wiring for agent startup.
 *
 * Attaches the process-wide diagnostic sinks to the diagnostic bus, in the
 * order the boot flow needs them: the per-session file log, the persistent
 * cross-session audit log, the scrollback sink (Warning+ terminal chrome),
 * and the opt-in stderr mirror. Lifted out of `src/index.ts` so the entry
 * point stays a thin composition root.
 *
 * The scrollback sink is RETURNED (not just attached) because the entry
 * point drives its two-phase lifecycle: `startBuffering()` here — before any
 * startup-banner row is drawn — and `flushBuffer()` later, after
 * `closeStartupTree()` commits the final row. Without that split, a warning
 * emitted mid-banner would tear through the box mid-paint.
 *
 * @module host/startup/diagnostic-sinks
 */

import { getDiagnosticBus } from "../../bus/diagnostic-bus.ts"
import { getSessionId } from "../../session/session-id.ts"
import type { ScrollbackDiagnosticSink } from "../ui/status/scrollback.ts"

/** Inputs the sink wiring needs from the entry point. */
export interface DiagnosticSinkOptions {
  /** Whether the startup banner will be drawn (arms scrollback buffering). */
  readonly showHeader: boolean
  /** The process environment (only `MINIMAL_AGENT_LOG_STDERR` is read). */
  readonly env: Record<string, string | undefined>
}

/**
 * Construct and attach the startup diagnostic sinks to the bus.
 *
 * @param opts - Header visibility + environment.
 * @returns The scrollback sink, so the caller can drive its buffer lifecycle.
 */
export async function attachStartupDiagnosticSinks(
  opts: DiagnosticSinkOptions,
): Promise<ScrollbackDiagnosticSink> {
  const bus = getDiagnosticBus()

  const { FileLogSink } = await import("../../logging/log-file.ts")
  new FileLogSink(getSessionId()).attach(bus)

  // Persistent, cross-session audit log (`~/.minimal-agent/ma.log`). Unlike
  // the per-session file sink above, this single durable log survives across
  // runs and records long-lived subsystem history. Notice+ only, session id
  // stamped into every line. Best-effort; never throws into boot.
  const { GlobalLogSink } = await import("../../logging/log-global.ts")
  new GlobalLogSink({ sessionId: getSessionId() }).attach(bus)

  // Scrollback sink — renders Warning+ events as gutter-bracketed blocks
  // (gold ⚠ warn / red ✗ error) in the persistent terminal transcript.
  // Attached here, before any other subsystem can emit, so the first error
  // of the session is captured.
  const { ScrollbackDiagnosticSink } = await import("../ui/status/scrollback.ts")
  const scrollbackSink = new ScrollbackDiagnosticSink()
  scrollbackSink.attach(bus)

  // Start buffering immediately: any diagnostic that fires during the banner
  // window gets queued and flushed below the banner once the startup tree's
  // final row is committed.
  if (opts.showHeader) scrollbackSink.startBuffering()

  if (opts.env.MINIMAL_AGENT_LOG_STDERR === "1") {
    // No interceptor yet — write straight to fd 2. The live-area bootstrap
    // re-attaches a compositor-aware mirror once the interceptor exists.
    const { StderrMirrorSink } = await import("../../logging/log-stderr.ts")
    new StderrMirrorSink().attach(bus)
  }

  return scrollbackSink
}

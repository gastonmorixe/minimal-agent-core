/**
 * Session diagnostics into the session event log (S21).
 *
 * {@link bridgeDiagnosticsToEventLog} subscribes to one session's diagnostics
 * scope and appends each diagnostic to that session's
 * {@link SessionEventLog} as a `ch: "diag"` entry. Events (`ch: "event"`)
 * and diagnostics then share one ordered log and one wire format (JSONL, or
 * SSE with `id: seq`), so every host reads both with one subscribe call and
 * a reconnect resumes both from the same `seq`.
 *
 * The runtime (S47) attaches one bridge per session when it opens the
 * session, next to the AgentCore `eventSink` that appends events.
 *
 * @module diagnostics/event-log-bridge
 */

import type { DiagnosticFilter, Severity } from "../bus/diagnostic-bus.ts"
import { diagnosticFromLogEvent, type SessionEventLog } from "../session/event-log.ts"

import type { SessionDiagnostics } from "./hub.ts"

/** Options for {@link bridgeDiagnosticsToEventLog}. */
export interface EventLogBridgeOptions {
  /**
   * Least severe diagnostic to record. RFC 5424 numbers run backwards, so
   * `Severity.Notice` records notice and everything more severe. Default:
   * every severity. Subscribers can still filter with `minSeverity`.
   */
  readonly minSeverity?: Severity
}

/** The part of a {@link SessionEventLog} the bridge writes to. */
export type DiagnosticLogTarget = Pick<SessionEventLog, "sessionId" | "appendDiag">

/**
 * Append every diagnostic of `scope` to `log` as a `ch: "diag"` entry, from
 * now on. Returns a function that stops the bridge.
 *
 * @throws RangeError when the scope and the log belong to different sessions
 */
export function bridgeDiagnosticsToEventLog(
  scope: SessionDiagnostics,
  log: DiagnosticLogTarget,
  options: EventLogBridgeOptions = {},
): () => void {
  if (scope.sessionId !== log.sessionId) {
    throw new RangeError(
      `diagnostics of session ${scope.sessionId} cannot go to the event log of session ${log.sessionId}`,
    )
  }
  const { minSeverity } = options
  const filter: DiagnosticFilter =
    minSeverity === undefined ? "*" : (event) => event.severity <= minSeverity
  return scope.on(filter, (event) => {
    log.appendDiag(diagnosticFromLogEvent(event))
  })
}

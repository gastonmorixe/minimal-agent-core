/**
 * The one stdout writer for `--output-format stream-json` lines.
 *
 * It is a process-wide singleton. It owns the line counter `seq`, so every
 * line on stdout gets the next number with no gaps, whoever writes it. It
 * also records two facts: whether `session_started` was written, and whether
 * `run_finished` was written.
 *
 * `session_started` means a session context exists: the host knows the
 * session id and the model. It does not mean the session opened.
 *
 * Failure lines: when the run fails after argv parse, the host calls
 * {@link writeStreamJsonFailure}. It writes an `error` line and then a
 * `run_finished` line with outcome `failed`, so stdout still ends with
 * machine-readable lines. It writes nothing when `run_finished` is already
 * on stdout. These lines appear only for stream-json. Argv and flag errors
 * happen before this point and go to stderr only. The json and text routes
 * never use this module.
 *
 * @module host/startup/stream-json-writer
 */

import { fatalErrorFields } from "../../llm/error-hint.ts"
import type { AgentEvent, SessionStartedLine } from "../../sdk/events.ts"
import { serializeStreamJsonLine } from "../../sdk/events.ts"

/** Host-known values for the stream-json `session_started` line. */
export interface StreamInfo {
  readonly sessionId: string
  /** The source session id of a forked `--resume`. Unset for a fresh run or an in-place resume. */
  readonly resumedFrom?: string
  readonly model: string
  readonly provider?: string
  readonly effort?: string
  readonly version?: string
  readonly cwd: string
}

/** What the host knows when a run fails. */
export interface StreamFailureContext {
  /** The session id for the envelope of each failure line. */
  readonly sessionId: string
  /**
   * The values for `session_started`. Set it when the model is known. When it
   * is set and no `session_started` line is on stdout yet, the failure path
   * writes that line first.
   */
  readonly streamInfo?: StreamInfo
}

type Write = (chunk: string) => void

const defaultWrite: Write = (chunk) => void process.stdout.write(chunk)

let write: Write = defaultWrite
let seq = 0
let startedWritten = false
let finishedWritten = false

/** Send the stream-json lines to `fn` instead of `process.stdout`. */
export function setStreamJsonWrite(fn: Write): void {
  write = fn
}

/** Build the `session_started` line body, keys in wire order. */
export function sessionStartedLine(info: StreamInfo): SessionStartedLine {
  return {
    type: "session_started",
    streamVersion: 1,
    sessionId: info.sessionId,
    // Unknown values are null, so every line has the same keys.
    resumedFrom: info.resumedFrom ?? null,
    model: info.model,
    provider: info.provider ?? null,
    effort: info.effort ?? null,
    cwd: info.cwd,
    version: info.version ?? null,
    outputFormat: "stream-json",
  }
}

/** Write the `session_started` line once. A second call does nothing. */
export function writeStreamJsonSessionStarted(info: StreamInfo): void {
  if (startedWritten) return
  startedWritten = true
  const env = { sessionId: info.sessionId, seq: seq++, ts: Date.now() }
  write(serializeStreamJsonLine(sessionStartedLine(info), env))
}

/** Write one event line. A `run_finished` event closes the stream. */
export function writeStreamJsonEvent(
  event: AgentEvent,
  ctx: { readonly sessionId: string; readonly ts: number },
): void {
  if (event.type === "run_finished") finishedWritten = true
  write(serializeStreamJsonLine(event, { sessionId: ctx.sessionId, seq: seq++, ts: ctx.ts }))
}

/**
 * Write the failure lines for `err`: `error`, then `run_finished`. An abort
 * gets no `error` line and the outcome `aborted`, the same as `AgentCore.run`.
 * Does nothing when `run_finished` is already on stdout.
 */
export function writeStreamJsonFailure(err: unknown, ctx: StreamFailureContext): void {
  if (finishedWritten) return
  if (ctx.streamInfo !== undefined) writeStreamJsonSessionStarted(ctx.streamInfo)
  const fields = fatalErrorFields(err)
  const ts = Date.now()
  if (fields) writeStreamJsonEvent({ type: "error", ...fields }, { sessionId: ctx.sessionId, ts })
  const outcome = fields ? "failed" : "aborted"
  writeStreamJsonEvent({ type: "run_finished", outcome }, { sessionId: ctx.sessionId, ts })
}

/** Test hook: clear the counter and the flags, and restore `process.stdout`. */
export function resetStreamJsonWriterForTests(): void {
  write = defaultWrite
  seq = 0
  startedWritten = false
  finishedWritten = false
}

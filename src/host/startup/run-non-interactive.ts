/**
 * Non-interactive (`--prompt` / `-` / bare-positional) agent run.
 *
 * Owns the one-shot output path. Two routes:
 *
 *   - **Legacy / human + `--output-schema`**: formatter spin-up, `--json` vs
 *     human vs `--output-schema` routing (via {@link PrintOutput}), streaming
 *     the agent's chunks through the plugin stream, and the schema
 *     validate-and-exit gate. Behavior here is UNCHANGED — `text` mode is
 *     byte-identical to before this module grew the event-stream branch.
 *   - **Structured event stream (`--output-format json` / `stream-json`)**:
 *     when the host injects a
 *     {@link RunNonInteractivePromptInput.openEventStreamSession} factory and
 *     the format is `json`/`stream-json` (and no `--output-schema`), the run
 *     drives a `createRuntime`/`Session` turn (`session.run()`) and
 *     serializes every {@link SessionEntry} whose `data.kind` is kept to
 *     one JSONL line on stdout, in the exact wire format
 *     {@link serializeEvent} produces. `json` keeps
 *     {@link LEGACY_EVENT_KINDS}. `stream-json` keeps
 *     {@link STREAM_JSON_EVENT_KINDS}, so its last line is `run_finished`.
 *     Each stream-json line also carries `sessionId`, `seq`, and `ts` after
 *     the event keys (see {@link serializeStreamJsonLine}). json lines do not.
 *     When the host passes {@link RunNonInteractivePromptInput.streamInfo},
 *     the first stream-json line is `session_started`, written before the
 *     session opens.
 *     All stream-json lines go through one writer
 *     (`host/startup/stream-json-writer.ts`), which owns `seq`. A failure
 *     after argv parse still ends stdout with an `error` line and a
 *     `run_finished` line with outcome `failed`: the core writes them for a
 *     failure inside the run, and the host writes them for a failure outside
 *     it (a failed session open, a resume failure, a `turn.willStart` halt).
 *     Argv and flag errors give no JSON. They go to stderr only.
 *     The events ARE the output; the yielded text channel is drained and
 *     discarded (the `item_completed` events already carry the assistant
 *     text).
 *
 * `Session`'s own event log always captures every `AgentEvent` kind — that is
 * its whole point, a complete trace (agent E's S48 design) — so this module
 * does NOT ask it to log anything less. It filters at its OWN subscription
 * boundary instead. The `json` route keeps the frozen `LEGACY_EVENT_KINDS`
 * wire format it has always shipped (`events-jsonl.integration.test.ts`).
 * The `stream-json` route also keeps the closing `run_finished` line.
 *
 * The `Session` is built by an INJECTED factory, not constructed here: the
 * host (index.ts) closes over its collaborators and calls the
 * `openAgentCoreSession(deps)` seam (`src/host/sdk-adapters/build-agent-core.ts`)
 * — the same host collaborators `buildAgentCore` wires, handed to
 * `createRuntime().openSession(...)` instead of `new AgentCore(...)`. That
 * keeps this file free of the `src/host/sdk-adapters/` lane and lets `json`/
 * `stream-json` fall back to the legacy path until the factory is wired, so no
 * path regresses before integration.
 *
 * Split out of `src/index.ts` to keep the entry point under the `max-lines`
 * lint budget.
 *
 * @module host/startup/run-non-interactive
 */

import type { OutputFormat } from "../../cli/output-format.ts"
import { fatalErrorFields } from "../../llm/error-hint.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import { PluginStream } from "../../plugins/stream.ts"
import type { Session } from "../../runtime/session.ts"
import { LEGACY_EVENT_KINDS, STREAM_JSON_EVENT_KINDS, serializeEvent } from "../../sdk/events.ts"
import { enforceOutputSchema, PrintOutput, resolvePrintModeOptions } from "../print-output.ts"
import type { ReplAgentLike } from "../repl.ts"
import { applyTurnWillStart } from "../repl-editor-hooks.ts"
import { Formatter } from "../ui/formatter/formatter.ts"

import {
  type StreamInfo,
  setStreamJsonWrite,
  writeStreamJsonEvent,
  writeStreamJsonFailure,
  writeStreamJsonSessionStarted,
} from "./stream-json-writer.ts"

export type { StreamInfo } from "./stream-json-writer.ts"

/** The stderr text of a `turn.willStart` halt. */
const TURN_BLOCKED_MESSAGE = "turn.willStart: prompt blocked by lifecycle policy hook."

/** `LEGACY_EVENT_KINDS`, as a `Set` for an O(1) membership check per entry. */
const LEGACY_EVENT_KIND_SET: ReadonlySet<string> = new Set(LEGACY_EVENT_KINDS)

/** `STREAM_JSON_EVENT_KINDS`, as a `Set`. It adds `run_finished` to the legacy nine. */
const STREAM_JSON_EVENT_KIND_SET: ReadonlySet<string> = new Set(STREAM_JSON_EVENT_KINDS)

/** Inputs for {@link runNonInteractivePrompt}. */
export interface RunNonInteractivePromptInput {
  /** The initialized agent / InteractiveSession to drive. */
  readonly agent: ReplAgentLike
  /** The resolved one-shot prompt text. */
  readonly prompt: string
  /** Resolved formatter argv, or undefined when none. */
  readonly formatterCmd: string[] | undefined
  /** Whether the startup header was shown (drives the leading blank line). */
  readonly showHeader: boolean
  /** `--json` output-mode flag. */
  readonly wantJsonOutput: boolean
  /**
   * The resolved output format (`text` | `json` | `stream-json`). Optional so
   * the entry point can adopt it incrementally: when omitted the run behaves
   * exactly as the `--json` boolean dictates (legacy path). When it is
   * `json`/`stream-json` AND {@link openEventStreamSession} is provided (and
   * no `outputSchema`), the structured event-stream path runs instead.
   */
  readonly outputFormat?: OutputFormat
  /** Parsed `--output-schema`, or undefined. */
  readonly outputSchema: object | undefined
  /** The active plugin loader when plugins loaded, else null. */
  readonly loader: PluginLoader | null
  /** Working directory for the plugin stream. */
  readonly cwd: string
  /**
   * Injected `Session` factory for the structured event-stream path. The host
   * closes over its collaborators and calls the `openAgentCoreSession(deps)`
   * seam (`src/host/sdk-adapters/build-agent-core.ts`) — the same host
   * collaborators `buildAgentCore` wires, over `createRuntime().openSession`
   * instead of `new AgentCore(...)`. Absent until the entry point wires it,
   * in which case `json`/`stream-json` fall back to the legacy path so
   * nothing regresses.
   *
   * Returns a promise: the real `openAgentCoreSession(deps)` awaits the
   * plugin prompt block asynchronously at construction (for G1 byte-parity),
   * so the factory is awaited here.
   */
  readonly openEventStreamSession?: () => Promise<Session>
  /**
   * Session info for the first stream-json line (`session_started`). When it
   * is set and the format is `stream-json`, that line is written at seq 0,
   * before the session opens. When it is unset, no such line is written and
   * events start at seq 0. The json route ignores it. Never put auth,
   * tokens, credential names, or env values here.
   */
  readonly streamInfo?: StreamInfo
  /**
   * Where JSONL event lines go in the structured path. Injected for testing;
   * defaults to `process.stdout`. Only consulted on the event-stream route.
   */
  readonly stdout?: (chunk: string) => void
  /** Exit hook for tests. Defaults to `process.exit`. */
  readonly exit?: (code: number) => never
}

/**
 * Whether this run should take the structured event-stream route: a
 * `json`/`stream-json` format, an injected session factory, and no
 * `--output-schema` (schema enforcement stays on the buffered legacy path so
 * its byte-for-byte exit semantics are preserved).
 */
function wantsEventStream(input: RunNonInteractivePromptInput): boolean {
  const fmt = input.outputFormat
  if (fmt !== "json" && fmt !== "stream-json") return false
  if (input.openEventStreamSession === undefined) return false
  if (input.outputSchema !== undefined) return false
  return true
}

/**
 * Drive a `Session` turn (`session.run()`) and emit its kept entries as
 * JSONL to stdout. Used for `--output-format json` / `stream-json`. `json`
 * keeps `LEGACY_EVENT_KINDS`. `stream-json` keeps `STREAM_JSON_EVENT_KINDS`,
 * which adds the closing `run_finished` line. That line is written before
 * any `exit` call, because `Session` drains its queue first. Each stream-json
 * line gets the envelope keys `sessionId` (the entry's session id), `seq` (a
 * count of lines on this stdout, from 0), and `ts` (the entry's epoch ms).
 * json lines stay byte-identical to `serializeEvent(entry.data)`.
 *
 * `Session`'s own event log always captures every `AgentEvent` kind (its
 * whole point, a complete trace) — this function filters AT THIS
 * SUBSCRIPTION BOUNDARY instead of asking it to log anything less, so the
 * line written for each kept entry is `serializeEvent(entry.data)`, the
 * exact same bytes `JsonlEventSink` would have written for that same event.
 * Each kept entry is written the instant `session.run()` yields it, so
 * `stream-json` is live by construction; `json` sees the same events (it
 * does not opt into deltas, so none are ever kept for it). The yielded text
 * channel is drained and discarded: the `item_completed` events already
 * carry the assistant text, matching the frozen SDK wire contract
 * (`events-jsonl.integration.test.ts`).
 */
async function runCoreEventStream(input: RunNonInteractivePromptInput): Promise<void> {
  const write = input.stdout ?? ((chunk: string) => void process.stdout.write(chunk))
  const exit = input.exit ?? ((code: number): never => process.exit(code))
  // Non-null: wantsEventStream() already verified openEventStreamSession is
  // present. It returns a promise (the real openAgentCoreSession awaits the
  // plugin prompt block), so await it before running.
  const openSession = input.openEventStreamSession as () => Promise<Session>

  // stream-json is the realtime surface: opt into token-level text_delta /
  // thinking_delta events. json stays buffered (no deltas) so its event stream
  // matches Phase 2 and the frozen SDK golden.
  const isStreamJson = input.outputFormat === "stream-json"
  const emitDeltas = isStreamJson
  // stream-json also keeps the closing run_finished line. json stays frozen.
  const keep = isStreamJson ? STREAM_JSON_EVENT_KIND_SET : LEGACY_EVENT_KIND_SET
  // stream-json lines carry an envelope. The shared writer owns seq, which
  // counts the lines on this stdout from 0. It is not entry.seq, which counts
  // every logged entry. The json route does not use the writer.
  if (isStreamJson) setStreamJsonWrite(write)

  // The session_started line goes first, before the open, so a failed open
  // still leaves it on stdout. The open error then propagates as before, and
  // the host's main().catch writes the failure lines.
  if (isStreamJson && input.streamInfo !== undefined) {
    writeStreamJsonSessionStarted(input.streamInfo)
  }

  const session = await openSession()

  try {
    const run = session.run(input.prompt, { emitDeltas })
    for await (const entry of run) {
      // Text chunks are carried by the event stream (item_completed); the
      // raw yield channel is not written to stdout in structured mode. The
      // session's own log is the COMPLETE trace (every AgentEvent kind, by
      // design). THIS is the subscription boundary that filters it down to
      // the wire format of the route (LEGACY_EVENT_KINDS for json,
      // STREAM_JSON_EVENT_KINDS for stream-json). It does not change what
      // Session logs internally.
      if (entry.ch === "event" && keep.has(entry.data.type)) {
        if (isStreamJson) {
          writeStreamJsonEvent(entry.data, { sessionId: entry.sessionId, ts: entry.ts })
        } else {
          write(serializeEvent(entry.data))
        }
      }
    }
    const result = await run.result
    // A paused run (permanent error) already emitted its `error` event.
    // Nobody can answer a one-shot run, so exit non-zero like a failure.
    if (result.outcome === "waiting") exit(1)
  } catch (err) {
    // The core already surfaced the fatal error on the stream as an `error`
    // event (with code/hint). Keep stdout a clean JSONL document (no stack
    // trace), but exit non-zero so scripts see the failure. An abort is not
    // a failure of the run itself.
    if (fatalErrorFields(err)) exit(1)
  }
}

/** Write the stream-json failure lines for a `turn.willStart` halt. */
function writeTurnBlocked(input: RunNonInteractivePromptInput): void {
  if (input.stdout !== undefined) setStreamJsonWrite(input.stdout)
  const err = Object.assign(new Error(TURN_BLOCKED_MESSAGE), { code: "turn.blocked" })
  const info = input.streamInfo
  writeStreamJsonFailure(err, {
    sessionId: info?.sessionId ?? "",
    ...(info !== undefined ? { streamInfo: info } : {}),
  })
}

/**
 * Run one non-interactive prompt to completion and print its answer per the
 * selected output mode. Returns when the run is done; may call `exit(1)` on a
 * schema-validation failure.
 */
export async function runNonInteractivePrompt(input: RunNonInteractivePromptInput): Promise<void> {
  const { agent, formatterCmd, outputSchema, loader } = input
  const exit = input.exit ?? ((code: number): never => process.exit(code))

  // Parity with REPL: `turn.willStart` may rewrite or halt before the model.
  const turn = await applyTurnWillStart(loader, input.prompt)
  if (turn.halted) {
    process.stderr.write(`${TURN_BLOCKED_MESSAGE}\n`)
    // stream-json still ends stdout with error and run_finished failed lines.
    if (input.outputFormat === "stream-json") writeTurnBlocked(input)
    exit(1)
  }
  const prompt = turn.text

  // Structured event-stream route (`--output-format json` / `stream-json`).
  // Bypasses the formatter/plugin-stream/human-answer machinery entirely: the
  // JSONL event stream is the whole output.
  if (wantsEventStream(input)) {
    await runCoreEventStream({ ...input, prompt })
    return
  }

  // Breathing room between the closed startup tree (stderr) and the streamed
  // response (stdout). Skipped when the header is suppressed (script-friendly).
  if (input.showHeader) process.stdout.write("\n")
  const formatter = formatterCmd ? new Formatter(formatterCmd, process.stdout) : null
  if (formatter) formatter.start()

  const stdoutIsTTY = process.stdout.isTTY === true
  // json / stream-json imply JSON output even when the `--json` boolean was
  // not passed, so `--output-format json` behaves as the documented `--json`
  // alias on the legacy path too (the full event stream is taken above via
  // wantsEventStream once a session factory is injected). `text` and an
  // absent outputFormat leave this exactly as `wantJsonOutput` dictates, so the
  // default text path stays byte-identical.
  const jsonFromFormat = input.outputFormat === "json" || input.outputFormat === "stream-json"
  const printOpts = resolvePrintModeOptions({
    jsonFlag: input.wantJsonOutput || jsonFromFormat,
    stdoutIsTTY,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  })
  const printOut = new PrintOutput(printOpts, {
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutIsTTY,
  })

  // Suppress live streaming when output is BUFFERED: json mode (events are the
  // only stdout) OR --output-schema (the answer must be validated before any
  // byte reaches stdout). Otherwise stream chunk-by-chunk (the live feel).
  const jsonMode = printOut.outputMode() === "json"
  const buffered = jsonMode || outputSchema !== undefined
  const baseSink = (s: string) => {
    if (buffered) return
    if (formatter) formatter.write(s)
    else process.stdout.write(s)
  }
  const pluginStream = loader ? new PluginStream(baseSink, loader, input.cwd) : null

  let finalText = ""
  try {
    const gen = agent.run(prompt)
    while (true) {
      const { done, value } = await gen.next()
      if (done) break
      finalText += value
      if (pluginStream) {
        const p = pluginStream.feed(value)
        if (p) await p
      } else {
        baseSink(value)
      }
    }
    if (pluginStream) await pluginStream.end()
  } finally {
    if (formatter) await formatter.end()
  }

  // --output-schema validate-and-exit: the final answer must be valid JSON
  // matching the schema, else a diagnostic to stderr + exit 1. Runs BEFORE any
  // stdout write so a failing run never leaks a non-conforming answer.
  if (outputSchema !== undefined) {
    const enforcement = enforceOutputSchema(finalText, outputSchema)
    if (!enforcement.ok) {
      for (const line of enforcement.diagnostics) process.stderr.write(`${line}\n`)
      exit(1)
    }
  }

  if (jsonMode) {
    printOut.finish(finalText)
  } else if (outputSchema !== undefined) {
    process.stdout.write(finalText.endsWith("\n") ? finalText : `${finalText}\n`)
  } else {
    process.stdout.write("\n")
  }
}

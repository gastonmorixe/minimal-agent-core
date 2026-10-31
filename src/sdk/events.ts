/**
 * Structured agent-event surface for `--json` (JSONL) mode.
 *
 * The agent core emits a stream of {@link AgentEvent}s through an
 * {@link EventSink}. Host adapters implement the sink: the CLI's `--json`
 * mode serializes each event to one JSONL line via {@link serializeEvent},
 * a test harness collects them into an array, a future SDK consumer routes
 * them to a callback. The core never knows which.
 *
 * Design principles (from software-best-design-patterns):
 *   - Dependency Inversion (DIP): the core depends on the EventSink port,
 *     not on any concrete writer.
 *   - Interface Segregation (ISP): the sink is one method, `emit`.
 *   - Discriminated union: every event carries a literal `type` tag so a
 *     consumer narrows variants exhaustively with a `switch (e.type)`.
 *
 * The event shapes mirror the agent loop's lifecycle (one turn = one model
 * response). They are a STABLE, host-facing contract, deliberately coarser
 * than the provider-level {@link CanonicalEvent} stream: a host wiring up
 * `--json` should not have to track per-delta SSE frames.
 *
 * @module sdk/events
 */

import type { TurnNotice } from "../agent/turn-notice.ts"
import type { StatusFields } from "../bus/status-port.ts"
import type { StopReason } from "../llm/canonical-events.ts"

import type { TurnOutcome } from "./stop-policy.ts"

export type { StatusFields, StatusPhase } from "../bus/status-port.ts"

// ---------------------------------------------------------------------------
// Usage + item kinds
// ---------------------------------------------------------------------------

/**
 * Token usage for a completed turn. A narrow, host-facing projection of the
 * provider-level usage snapshot: the four counters a `--json` consumer
 * actually reports. Missing fields stay `undefined` (the provider did not
 * report them) rather than `0` ("reported as zero").
 */
export interface EventUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

/**
 * The kind of content item the assistant produced. Mirrors the three
 * top-level content-block categories the agent loop streams: assistant
 * prose (`text`), a tool invocation (`tool_use`), and server-side
 * reasoning (`thinking`).
 */
export type ItemType = "text" | "tool_use" | "thinking"

// ---------------------------------------------------------------------------
// Event variants
// ---------------------------------------------------------------------------

/** A new assistant turn (one model response) has begun. */
export interface TurnStartedEvent {
  type: "turn_started"
  /**
   * Monotonic index of this turn, starting at 1. A resumed run goes on
   * from the saved round, so it does not restart at 1.
   */
  turn: number
}

/**
 * A content item (text / tool_use / thinking) opened within the turn.
 *
 * The core emits it, and its {@link ItemCompletedEvent}, from the final
 * blocks after the model response ends. It is not live. On the realtime
 * path, the turn's {@link TextDeltaEvent}s and {@link ThinkingDeltaEvent}s
 * come first.
 */
export interface ItemStartedEvent {
  type: "item_started"
  /** Which kind of item opened. */
  itemType: ItemType
  /**
   * Stable id for correlating this start with its {@link ItemCompletedEvent}
   * and, for a `tool_use` item, the later {@link ToolResultEvent}. For a
   * tool call this is the tool_use id; for text/thinking, an index-derived id.
   */
  id: string
  /**
   * Old name of {@link ItemStartedEvent.toolName} on a `tool_use` item. Kept
   * until the CLI renders from events (spec S37); read `toolName`.
   */
  label?: string
  /** The tool name, on a `tool_use` item only. */
  toolName?: string
  /**
   * The exact input the model sent, on a `tool_use` item only. It is a copy,
   * so a sink that changes it does not change the history. Not capped: a
   * large Write or Edit payload appears in full.
   */
  input?: Record<string, unknown>
}

/** A previously-started content item closed. */
export interface ItemCompletedEvent {
  type: "item_completed"
  itemType: ItemType
  /** Same id as the matching {@link ItemStartedEvent}. */
  id: string
  /**
   * The item's final text. For `text` / `thinking` this is the accumulated
   * body; for `tool_use` this is the tool name (the input is on the matching
   * {@link ItemStartedEvent}, not duplicated here).
   */
  text?: string
}

/**
 * An incremental assistant-text token, streamed live as the model produces it.
 *
 * Emitted ONLY on the realtime path (`--output-format stream-json`): the agent
 * loop opts in per-run, so the buffered `json` mode and the frozen SDK golden
 * (which do not opt in) never see deltas. Concatenating every `text_delta.text`
 * for a turn reconstructs that turn's streamed assistant text; the turn's
 * terminal {@link ItemCompletedEvent} (itemType `text`) still carries the whole
 * accumulated body, so a consumer uses EITHER the deltas OR the terminal item,
 * not both.
 *
 * `id` is a per-turn streaming id, `"<turn>:text"` (e.g. `"1:text"`), shared by
 * every text_delta of that turn. It groups a turn's text deltas and separates
 * them from that turn's {@link ThinkingDeltaEvent}s; it is deliberately NOT a
 * block-index item id (the streamed text precedes block finalization, when the
 * index is known), so do not join it to an `item_started.id`.
 */
export interface TextDeltaEvent {
  type: "text_delta"
  /** Per-turn streaming id `"<turn>:text"`, grouping this turn's text deltas. */
  id: string
  /** The incremental text chunk (a token or small run of tokens). */
  text: string
}

/**
 * An incremental model-reasoning token, streamed live as the model thinks.
 *
 * The reasoning counterpart to {@link TextDeltaEvent}: emitted only on the
 * realtime `stream-json` path, forwarding the transport's `onThinkingDelta`
 * callback as a structured event. Absent in buffered `json` and in the frozen
 * golden. `id` is the per-turn streaming id `"<turn>:thinking"`, distinct from
 * the turn's `text_delta` id so a consumer can separate the two live streams.
 */
export interface ThinkingDeltaEvent {
  type: "thinking_delta"
  /** Per-turn streaming id `"<turn>:thinking"`, grouping this turn's reasoning. */
  id: string
  /** The incremental reasoning chunk. */
  text: string
}

/** The result of executing a tool call that the assistant requested. */
export interface ToolResultEvent {
  type: "tool_result"
  /** The tool_use id this result answers (matches the ItemStarted id). */
  id: string
  /** The tool name, for display without cross-referencing the start event. */
  name: string
  /** Whether the tool reported an error. */
  isError: boolean
  /** One-line summary of the tool input. */
  inputSummary?: string
  /** One-line summary of the model-facing tool output. */
  outputSummary?: string
  /** Wall time the tool ran, in ms. */
  durationMs?: number
}

/**
 * The model asked to run a tool, and the loop is about to run it. `callId`
 * is the tool_use id, the same id as the `item_started` and `tool_result`
 * of this call. `input` is the input exactly as the model sent it.
 */
export interface ToolCallEvent {
  type: "tool_call"
  callId: string
  toolName: string
  input: Record<string, unknown>
  /** One-line summary of `input`. */
  inputSummary: string
}

/** Most UTF-8 bytes of tool output one {@link ToolOutputEvent} carries. */
export const TOOL_OUTPUT_TEXT_CAP = 16 * 1024

/**
 * The model-facing text a tool returned. Opt-in: only a sink that lists
 * `tool_output` in {@link EventSink.kinds} gets it. Emitted after the tool
 * ran and before its {@link ToolResultEvent}.
 */
export interface ToolOutputEvent {
  type: "tool_output"
  callId: string
  toolName: string
  /** The output text, cut to {@link TOOL_OUTPUT_TEXT_CAP} bytes. */
  text: string
  /** True when the cap cut `text`. */
  truncated: boolean
  /** UTF-8 byte length of the whole output text. */
  totalBytes: number
}

/** The current turn finished. Carries the final stop reason and usage. */
export interface TurnCompletedEvent {
  type: "turn_completed"
  turn: number
  /** Canonical stop reason, or `null` when the provider reported none. */
  stopReason: StopReason | null
  /** Token usage for the turn. */
  usage: EventUsage
}

/**
 * An out-of-band condition the loop surfaced mid-run: a provider refusal /
 * content filter, an output-budget event (max_tokens salvage / continue /
 * cap), a terminal-less stream salvage, or a reflection-ack confirmation.
 * Non-terminal: the run continues (or settles via a following
 * {@link TurnCompletedEvent}). Carries the full semantic {@link TurnNotice}
 * so a `--json` consumer gets the category / attempt / message structurally
 * instead of parsing a rendered string. Its `kind` and `severity` are the
 * fields most consumers route on.
 */
export interface NoticeEvent {
  type: "notice"
  notice: TurnNotice
}

/**
 * An error ended the turn. With `recoverable: false` the run is paused, not
 * over: a `status` event with phase `waiting_for_host` follows, and the host
 * can fix the cause and send the next run on the same session.
 */
export interface ErrorEvent {
  type: "error"
  message: string
  /** Stable machine code from the thrown provider error, when present. */
  code?: string
  /** One-line user next step from the thrown provider error, when present. */
  hint?: string
  /** `false` when the loop paused on a permanent error (stop-table row 11). */
  recoverable?: boolean
}

/**
 * What the loop does now (a request, a tool, or a wait). Phase codes and
 * numbers only, per {@link StatusFields} (the same shape the `StatusPort`
 * host port in `bus/status-port.ts` takes); labels are the host's job. Each
 * `status` event replaces the one before it.
 */
export interface StatusEvent extends StatusFields {
  type: "status"
}

/** The text the user sent: the run input, or text queued during the run. */
export interface UserMessageEvent {
  type: "user_message"
  text: string
  /** True for text the host queued while the run was going. */
  queued?: boolean
}

/**
 * Provider quota news: a model response arrived (the provider may have new
 * rate-limit data), or the loop waits for a quota reset. Core does not read
 * provider rate-limit headers, so `used` and `limit` are set only when known.
 */
export interface QuotaEvent {
  type: "quota"
  /** The provider id of the request. */
  provider: string
  used?: number
  limit?: number
  /** Quota reset time, epoch ms. */
  resetAt?: number
}

/**
 * The run ended. Every `AgentCore.run` emits exactly one, as its last event,
 * whatever the outcome. An aborted run emits `error` "aborted" first.
 */
export interface RunFinishedEvent {
  type: "run_finished"
  outcome: TurnOutcome
}

/** One answer the user can pick in an {@link AskUserEvent}. */
export interface AskUserOption {
  /** The id the host answers with. */
  id: string
  /** Short caption. */
  label: string
  /** One-line explanation. */
  description?: string
  /** At most one option per ask is the default. */
  isDefault?: boolean
  /** Picking it loses state (for example, it strips context). */
  destructive?: boolean
}

/**
 * The loop asks the user a question and waits for the answer from the
 * host's `askUser` port. One event per ask. A run without the port emits no
 * `ask_user`: it denies the ask with an `ask_denied` notice instead.
 */
export interface AskUserEvent {
  type: "ask_user"
  /** Id of this ask, unique per core. The host answers the ask by this id. */
  askId: string
  /** Stable machine code of the question (for example a preflight issue code). */
  code: string
  /** One-line title. */
  title: string
  /** Body text. `\n` breaks a paragraph. */
  detail: string
  /** The answers the user can pick, in order. */
  options: AskUserOption[]
}

/**
 * The discriminated union of every structured agent event. Narrow on the
 * `type` field:
 *
 * ```ts
 * function render(e: AgentEvent): void {
 *   switch (e.type) {
 *     case "turn_started":   ...
 *     case "item_started":   ...
 *     case "turn_completed": ...   // e.usage, e.stopReason in scope
 *   }
 * }
 * ```
 */
export type AgentEvent =
  | TurnStartedEvent
  | ItemStartedEvent
  | ItemCompletedEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolResultEvent
  | TurnCompletedEvent
  | NoticeEvent
  | ErrorEvent
  | StatusEvent
  | AskUserEvent
  | UserMessageEvent
  | ToolCallEvent
  | ToolOutputEvent
  | QuotaEvent
  | RunFinishedEvent

/** Every `AgentEvent["type"]` tag, for exhaustiveness checks and routing. */
export type AgentEventType = AgentEvent["type"]

/**
 * The nine kinds of the first event contract. The JSON route
 * (`--output-format json`) passes only these, so its stream changes by
 * added keys, never by added lines. The stream-json route uses
 * {@link STREAM_JSON_EVENT_KINDS}.
 */
export const LEGACY_EVENT_KINDS: readonly AgentEventType[] = [
  "turn_started",
  "item_started",
  "item_completed",
  "text_delta",
  "thinking_delta",
  "tool_result",
  "turn_completed",
  "notice",
  "error",
]

/**
 * The kinds the stream-json route (`--output-format stream-json`) passes.
 * It is the legacy nine plus the closing `run_finished` line. When the host
 * knows the session info, the first line is a {@link SessionStartedLine}
 * (not an event kind, so it is not in this list). Each stream-json line also
 * carries a {@link StreamJsonEnvelope} (`sessionId`, `seq`, `ts`). The json
 * route stays frozen on {@link LEGACY_EVENT_KINDS}, with no envelope.
 *
 * A failure after argv parse still ends the stream with an `error` line and
 * a `run_finished` line with outcome `failed`. The core writes them for a
 * failure inside the run. The CLI writes them for a failure outside it, such
 * as a failed session open. Argv and flag errors give no lines. They go to
 * stderr only.
 */
export const STREAM_JSON_EVENT_KINDS: readonly AgentEventType[] = [
  ...LEGACY_EVENT_KINDS,
  "run_finished",
]

/**
 * Kinds a sink gets only when it asks. `text_delta` and `thinking_delta`
 * need the run option `emitDeltas` or a {@link EventSink.kinds} entry;
 * `tool_output` needs a `kinds` entry.
 */
export const OPT_IN_EVENT_KINDS: readonly AgentEventType[] = [
  "text_delta",
  "thinking_delta",
  "tool_output",
]

/** Every event kind, in contract order. */
export const ALL_EVENT_KINDS: readonly AgentEventType[] = [
  ...LEGACY_EVENT_KINDS,
  "status",
  "ask_user",
  "user_message",
  "tool_call",
  "tool_output",
  "quota",
  "run_finished",
]

// ---------------------------------------------------------------------------
// Sink port
// ---------------------------------------------------------------------------

/**
 * The host port the agent core emits events through. Implementations should
 * not throw; `emit` is called from inside the agent loop, and the core
 * isolates a throwing sink (its first throw emits one `events.sink-error`
 * diagnostic, and the run goes on).
 */
export interface EventSink {
  emit(event: AgentEvent): void
  /**
   * The kinds this sink takes. When set, the core emits only these kinds to
   * it, and an opt-in kind ({@link OPT_IN_EVENT_KINDS}) listed here is
   * produced for it. When unset, the sink takes every kind except
   * `tool_output`, and the deltas only when the run sets `emitDeltas`.
   */
  readonly kinds?: readonly AgentEventType[]
}

// ---------------------------------------------------------------------------
// JSONL serialization
// ---------------------------------------------------------------------------

/**
 * Serialize one event to a single JSONL line: the compact JSON encoding of
 * the event followed by a trailing newline. Concatenating the output of
 * successive calls yields a valid JSON Lines stream (one object per line),
 * the wire format of `--json` mode.
 */
export function serializeEvent(event: AgentEvent): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * The keys the stream-json route adds to each line, after the event keys.
 * `sessionId` is the session id. `seq` counts the lines on this stdout,
 * from 0, with no gaps. `ts` is epoch milliseconds (UTC): the time the
 * session log took the event, or for `session_started`, the time the host
 * wrote the line.
 * The json route does not add these keys.
 */
export interface StreamJsonEnvelope {
  readonly sessionId: string
  readonly seq: number
  readonly ts: number
}

/**
 * The first stream-json line, before the envelope keys. The host writes it
 * before it opens the session, so it is on stdout even when the open fails.
 * It is not an {@link AgentEvent} kind: no sink ever gets it. Keys are in
 * wire order. The key list is fixed: `resumedFrom`, `provider`, `effort`,
 * and `version` are `null` when the host does not know them, never left out.
 */
export interface SessionStartedLine {
  readonly type: "session_started"
  /** The stream-json format version. A breaking change bumps it. */
  readonly streamVersion: 1
  readonly sessionId: string
  /**
   * The source session id when this run is a forked `--resume`. Then
   * `sessionId` is the new forked id. Null for a fresh run and for an
   * in-place resume (`--resume-same-sid`), where the id does not change.
   */
  readonly resumedFrom: string | null
  readonly model: string
  readonly provider: string | null
  readonly effort: string | null
  readonly cwd: string
  readonly version: string | null
  readonly outputFormat: "stream-json"
}

/**
 * One stream-json line: an event, or the first `session_started` line, plus
 * its {@link StreamJsonEnvelope}.
 */
export type StreamJsonLine = (AgentEvent | SessionStartedLine) & StreamJsonEnvelope

/**
 * Serialize one stream-json line. The event keys come first (`type` first),
 * then `sessionId`, `seq`, and `ts`. A key the event already has (such as
 * `sessionId` on {@link SessionStartedLine}) keeps its place. This is the one
 * place that encodes the envelope, so a change to its format is one edit here.
 */
export function serializeStreamJsonLine(
  event: AgentEvent | SessionStartedLine,
  env: StreamJsonEnvelope,
): string {
  const line: StreamJsonLine = { ...event, sessionId: env.sessionId, seq: env.seq, ts: env.ts }
  return `${JSON.stringify(line)}\n`
}

/**
 * A {@link EventSink} that serializes each event to JSONL and hands the line
 * to a writer callback (e.g. `process.stdout.write`). The thin adapter most
 * `--json` hosts want: construct with the writer, inject as the sink.
 *
 * It is the JSON route's sink, so it takes {@link LEGACY_EVENT_KINDS} unless
 * the host passes other kinds.
 */
export class JsonlEventSink implements EventSink {
  constructor(
    private readonly write: (line: string) => void,
    readonly kinds: readonly AgentEventType[] = LEGACY_EVENT_KINDS,
  ) {}

  emit(event: AgentEvent): void {
    this.write(serializeEvent(event))
  }
}

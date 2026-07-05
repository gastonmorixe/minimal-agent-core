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
import type { StopReason } from "../llm/canonical-events.ts"

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
  /** Monotonic index of this turn within the run, starting at 0. */
  turn: number
}

/** A content item (text / tool_use / thinking) opened within the turn. */
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
}

/** A previously-started content item closed. */
export interface ItemCompletedEvent {
  type: "item_completed"
  itemType: ItemType
  /** Same id as the matching {@link ItemStartedEvent}. */
  id: string
  /**
   * The item's final text. For `text` / `thinking` this is the accumulated
   * body; for `tool_use` this is the tool name (the input is carried by the
   * tool layer, not duplicated here).
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
 * cap), the tool-rounds emergency cap, or a reflection-ack confirmation.
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

/** A fatal error aborted the run. Terminal: no further events follow. */
export interface ErrorEvent {
  type: "error"
  message: string
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

/** Every `AgentEvent["type"]` tag, for exhaustiveness checks and routing. */
export type AgentEventType = AgentEvent["type"]

// ---------------------------------------------------------------------------
// Sink port
// ---------------------------------------------------------------------------

/**
 * The host port the agent core emits events through. One method: hosts that
 * do not care about a given event simply ignore it. Implementations must not
 * throw : `emit` is called from inside the agent loop and a throwing sink
 * would abort the run.
 */
export interface EventSink {
  emit(event: AgentEvent): void
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
 * A {@link EventSink} that serializes each event to JSONL and hands the line
 * to a writer callback (e.g. `process.stdout.write`). The thin adapter most
 * `--json` hosts want: construct with the writer, inject as the sink.
 */
export class JsonlEventSink implements EventSink {
  constructor(private readonly write: (line: string) => void) {}

  emit(event: AgentEvent): void {
    this.write(serializeEvent(event))
  }
}

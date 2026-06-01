/**
 * Canonical streaming-event union consumed by the agent loop.
 *
 * Every provider adapter parses its native stream (Anthropic SSE,
 * OpenAI Chat SSE, OpenAI Responses SSE, future WS) into this union
 * before yielding. The agent loop is then provider-agnostic.
 *
 * Event ordering invariant (per assistant message):
 *
 * 1. exactly one {@link MessageStartEvent}.
 * 2. zero or more `*StartEvent` / `*DeltaEvent` / `*StopEvent` triples
 *    in content order. Open content blocks must close before the next
 *    block opens : the agent assumes one open block at a time, except
 *    on Anthropic interleaved streams where thinking and text can
 *    alternate (still one open at a time though).
 * 3. exactly one {@link MessageDeltaEvent} carrying the final
 *    `stopReason` / `stopDetails` / merged `usage`.
 * 4. exactly one {@link MessageStopEvent}.
 *
 * A {@link StreamErrorEvent} can fire at any point. {@link PingEvent}
 * fires as a no-op keepalive and the agent ignores it (it exists so
 * the watchdog sees activity).
 *
 * @module llm/canonical-events
 */

// ---------------------------------------------------------------------------
// Usage + stop details
// ---------------------------------------------------------------------------

/**
 * Token usage snapshot. All counters are cumulative across the current
 * response. Adapters fill what the provider reports; missing fields
 * stay `undefined` rather than 0 so the host can distinguish "zero" from
 * "unreported".
 */
export interface CanonicalUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /** Per-TTL breakdown when the provider reports it (Anthropic 4.7+). */
  cacheBreakdown?: { fiveMinute?: number; oneHour?: number }
  /** Server-side reasoning tokens. Anthropic 4.7+ + OpenAI gpt-5/o3/o4-mini. */
  reasoningTokens?: number
  /** Server-side web-search calls billed on this response. */
  webSearchRequests?: number
}

/** Canonical stop reasons. Adapters map from the provider's enum. */
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "pause_turn"
  | "context_window_exceeded"
  | "content_filter"
  | "error"

/**
 * Refusal / pause / filter details. Opaque `type` from the provider
 * (Anthropic 4.7+ `stop_details.type`) surfaced verbatim so the host
 * can route / log / display.
 */
export interface StopDetails {
  type: string
  message?: string
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface MessageStartEvent {
  type: "message_start"
  messageId: string
  modelId: string
  serviceTier?: string
  inferenceGeo?: string
  initialUsage: CanonicalUsage
}

export interface MessageDeltaEvent {
  type: "message_delta"
  stopReason: StopReason | null
  stopSequence?: string | null
  stopDetails?: StopDetails | null
  usage: CanonicalUsage
  /**
   * Provider-specific receipts that don't fit the canonical shape but
   * the host might want : Anthropic `context_management.applied_edits`,
   * OpenAI `response.completed.response` envelope, etc.
   */
  receipts?: Record<string, unknown>
}

export interface MessageStopEvent {
  type: "message_stop"
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface TextStartEvent {
  type: "text_start"
  /** Index inside the current message. 0-based, monotonic. */
  index: number
}

export interface TextDeltaEvent {
  type: "text_delta"
  index: number
  text: string
}

export interface TextStopEvent {
  type: "text_stop"
  index: number
  /** Full text of the just-closed block, when the provider reports it. */
  finalText?: string
}

// ---------------------------------------------------------------------------
// Thinking / reasoning
// ---------------------------------------------------------------------------

export interface ThinkingStartEvent {
  type: "thinking_start"
  index: number
}

export interface ThinkingDeltaEvent {
  type: "thinking_delta"
  index: number
  text: string
}

/**
 * Anthropic's cryptographic signature delta on a thinking block.
 * Opaque; host preserves verbatim for the next request to the same
 * provider. Not emitted by OpenAI adapters.
 */
export interface ThinkingSignatureEvent {
  type: "thinking_signature"
  index: number
  signature: string
}

export interface ThinkingStopEvent {
  type: "thinking_stop"
  index: number
}

// ---------------------------------------------------------------------------
// Tool use (assistant -> tool call)
// ---------------------------------------------------------------------------

export interface ToolUseStartEvent {
  type: "tool_use_start"
  index: number
  /** Stable id paired with later `tool_result`. */
  id: string
  name: string
}

export interface ToolUseInputDeltaEvent {
  type: "tool_use_input_delta"
  index: number
  /** Raw partial JSON fragment. The agent concatenates and parses. */
  partialJson: string
}

export interface ToolUseStopEvent {
  type: "tool_use_stop"
  index: number
  /** Fully assembled input, when the provider reports it. */
  input?: unknown
}

// ---------------------------------------------------------------------------
// Refusal (separate channel on OpenAI; same channel as text on Anthropic)
// ---------------------------------------------------------------------------

/**
 * Streaming refusal-text channel. OpenAI emits this as its own
 * `delta.refusal` field; Anthropic conveys refusals via
 * `stop_reason: "refusal"` + `stop_details` on the final
 * `MessageDeltaEvent` (the text is absent there).
 */
export interface RefusalDeltaEvent {
  type: "refusal_delta"
  text: string
}

// ---------------------------------------------------------------------------
// Stream errors + keepalive
// ---------------------------------------------------------------------------

export interface StreamErrorEvent {
  type: "stream_error"
  /** Whether the outer retry loop should re-attempt. */
  retryable: boolean
  /** Provider-mapped category for log/metrics. */
  category?:
    | "overloaded"
    | "api"
    | "timeout"
    | "rate_limit"
    | "billing"
    | "canceled"
    | "auth"
    | "unknown"
  /**
   * Raw provider error type (e.g. `"rate_limit_error"`, `"overloaded_error"`),
   * preserved verbatim so the retry coordinator can classify on the exact
   * upstream code instead of a lossy category round-trip. Optional: synthetic
   * errors (watchdog timeouts) have no upstream type.
   */
  upstreamType?: string
  /** Original error for chaining. */
  cause?: unknown
}

export interface PingEvent {
  type: "ping"
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export type CanonicalEvent =
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextStopEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingSignatureEvent
  | ThinkingStopEvent
  | ToolUseStartEvent
  | ToolUseInputDeltaEvent
  | ToolUseStopEvent
  | RefusalDeltaEvent
  | StreamErrorEvent
  | PingEvent

/**
 * Narrow `CanonicalEvent` by the literal `type` discriminator. Convenience
 * for switch cases that want a typed event variable without writing the
 * discriminated-union ceremony at every site.
 */
export function isEvent<T extends CanonicalEvent["type"]>(
  ev: CanonicalEvent,
  type: T,
): ev is Extract<CanonicalEvent, { type: T }> {
  return ev.type === type
}

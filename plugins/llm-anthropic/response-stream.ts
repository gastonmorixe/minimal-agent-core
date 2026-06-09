/**
 * Anthropic SSE → CanonicalEvent translator.
 *
 * Consumes raw `parseSse<AnthropicStreamEvent>` output and yields the
 * canonical event union the agent loop consumes.
 *
 * Verified against the live 2026-05-28 capture and the SSE shape
 * documented in `cli.patched.cjs` v2.1.154.
 *
 * Event ordering this translator emits per message:
 *
 *   message_start → (text_start | thinking_start | tool_use_start)*
 *                 → (*_delta | thinking_signature)*
 *                 → (*_stop)*
 *                 → message_delta → message_stop
 *
 * Errors are surfaced via the SSE `event: error` payload, mapped to
 * a `StreamErrorEvent`. We propagate transient categories (`overloaded`,
 * `api`) with `retryable:true` so the outer coordinator can restart
 * the attempt.
 *
 * @module llm/providers/anthropic/response-stream
 */

import type {
  CanonicalEvent,
  CanonicalUsage,
  StopDetails,
  StopReason,
} from "../../src/llm/canonical-events.ts"

// ---------------------------------------------------------------------------
// Anthropic wire types (subset we consume)
// ---------------------------------------------------------------------------

interface AnthropicStreamEventBase {
  type: string
}

interface MessageStartWire extends AnthropicStreamEventBase {
  type: "message_start"
  message: {
    id: string
    model: string
    usage?: AnthropicUsageWire
    stop_details?: StopDetailsWire | null
  }
}

interface ContentBlockStartWire extends AnthropicStreamEventBase {
  type: "content_block_start"
  index: number
  content_block:
    | { type: "text"; text?: string }
    | { type: "thinking"; thinking?: string; signature?: string }
    | { type: "tool_use"; id: string; name: string; input?: unknown }
}

interface ContentBlockDeltaWire extends AnthropicStreamEventBase {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
    | { type: "input_json_delta"; partial_json: string }
}

interface ContentBlockStopWire extends AnthropicStreamEventBase {
  type: "content_block_stop"
  index: number
}

interface MessageDeltaWire extends AnthropicStreamEventBase {
  type: "message_delta"
  delta: {
    stop_reason: string | null
    stop_sequence?: string | null
    stop_details?: StopDetailsWire | null
  }
  usage?: AnthropicUsageWire
  context_management?: { applied_edits: unknown[] }
}

interface MessageStopWire extends AnthropicStreamEventBase {
  type: "message_stop"
}

interface PingWire extends AnthropicStreamEventBase {
  type: "ping"
}

interface ErrorWire extends AnthropicStreamEventBase {
  type: "error"
  error: { type?: string; message?: string }
  request_id?: string
}

export type AnthropicStreamEvent =
  | MessageStartWire
  | ContentBlockStartWire
  | ContentBlockDeltaWire
  | ContentBlockStopWire
  | MessageDeltaWire
  | MessageStopWire
  | PingWire
  | ErrorWire

interface AnthropicUsageWire {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
  output_tokens_details?: {
    thinking_tokens?: number
  }
  server_tool_use?: {
    web_search_requests?: number
  }
  service_tier?: string
  inference_geo?: string
}

interface StopDetailsWire {
  type: string
  message?: string
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

/**
 * Translate the Anthropic SSE event stream into canonical events.
 *
 * Maintains per-block bookkeeping for tool_use input-JSON assembly so
 * the final `ToolUseStopEvent` carries a parsed `input` payload.
 *
 * @yields Canonical events translated from each Anthropic SSE event.
 */
export async function* translateAnthropicStream(
  events: AsyncIterable<AnthropicStreamEvent>,
): AsyncIterable<CanonicalEvent> {
  let lastUsage: CanonicalUsage = { inputTokens: 0, outputTokens: 0 }
  // Per-block index → accumulated tool_use JSON fragments.
  const toolJson = new Map<number, string>()
  // Per-block index → tool name (so stop events can include it).
  const toolNames = new Map<number, string>()
  // Per-block index → kind, to emit the right *_stop.
  const blockKind = new Map<number, "text" | "thinking" | "tool_use">()
  // Per-block index → accumulated text for finalText reporting.
  const blockText = new Map<number, string>()

  for await (const ev of events) {
    switch (ev.type) {
      case "message_start": {
        const initialUsage = mapUsage(ev.message.usage)
        lastUsage = initialUsage
        yield {
          type: "message_start",
          messageId: ev.message.id,
          modelId: ev.message.model,
          serviceTier: ev.message.usage?.service_tier,
          inferenceGeo: ev.message.usage?.inference_geo,
          initialUsage,
        }
        break
      }
      case "content_block_start": {
        const cb = ev.content_block
        const idx = ev.index ?? 0
        if (cb.type === "text") {
          blockKind.set(idx, "text")
          blockText.set(idx, cb.text ?? "")
          yield { type: "text_start", index: idx }
          if (cb.text) yield { type: "text_delta", index: idx, text: cb.text }
        } else if (cb.type === "thinking") {
          blockKind.set(idx, "thinking")
          blockText.set(idx, cb.thinking ?? "")
          yield { type: "thinking_start", index: idx }
          if (cb.thinking) yield { type: "thinking_delta", index: idx, text: cb.thinking }
          if (cb.signature) {
            yield { type: "thinking_signature", index: idx, signature: cb.signature }
          }
        } else if (cb.type === "tool_use") {
          blockKind.set(idx, "tool_use")
          toolJson.set(idx, "")
          toolNames.set(idx, cb.name)
          yield { type: "tool_use_start", index: idx, id: cb.id, name: cb.name }
        }
        break
      }
      case "content_block_delta": {
        const idx = ev.index ?? 0
        const d = ev.delta
        if (d.type === "text_delta") {
          blockText.set(idx, (blockText.get(idx) ?? "") + d.text)
          yield { type: "text_delta", index: idx, text: d.text }
        } else if (d.type === "thinking_delta") {
          blockText.set(idx, (blockText.get(idx) ?? "") + d.thinking)
          yield { type: "thinking_delta", index: idx, text: d.thinking }
        } else if (d.type === "signature_delta") {
          yield { type: "thinking_signature", index: idx, signature: d.signature }
        } else if (d.type === "input_json_delta") {
          toolJson.set(idx, (toolJson.get(idx) ?? "") + d.partial_json)
          yield { type: "tool_use_input_delta", index: idx, partialJson: d.partial_json }
        }
        break
      }
      case "content_block_stop": {
        const idx = ev.index ?? 0
        const kind = blockKind.get(idx)
        if (kind === "text") {
          yield { type: "text_stop", index: idx, finalText: blockText.get(idx) }
        } else if (kind === "thinking") {
          yield { type: "thinking_stop", index: idx }
        } else if (kind === "tool_use") {
          const raw = toolJson.get(idx) ?? ""
          let input: unknown
          try {
            input = raw ? JSON.parse(raw) : {}
          } catch {
            input = { _raw: raw }
          }
          yield { type: "tool_use_stop", index: idx, input }
        }
        break
      }
      case "message_delta": {
        const usage = mergeUsageInPlace(lastUsage, mapUsage(ev.usage))
        lastUsage = usage
        const stopReason = mapStopReason(ev.delta.stop_reason)
        const stopDetails: StopDetails | null = ev.delta.stop_details ?? null
        yield {
          type: "message_delta",
          stopReason,
          stopSequence: ev.delta.stop_sequence ?? null,
          stopDetails,
          usage,
          receipts: ev.context_management
            ? { context_management: ev.context_management }
            : undefined,
        }
        break
      }
      case "message_stop": {
        yield { type: "message_stop" }
        break
      }
      case "ping": {
        yield { type: "ping" }
        break
      }
      case "error": {
        const errType = ev.error?.type ?? "unknown_error"
        const errMessage = ev.error?.message ?? "stream error"
        yield {
          type: "stream_error",
          retryable: isRetryableErrorCategory(errType),
          category: categorizeUpstream(errType),
          upstreamType: errType,
          cause: new Error(`Anthropic stream error: ${errType} — ${errMessage}`),
        }
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapUsage(wire?: AnthropicUsageWire): CanonicalUsage {
  if (!wire) return { inputTokens: 0, outputTokens: 0 }
  const usage: CanonicalUsage = {
    inputTokens: wire.input_tokens ?? 0,
    outputTokens: wire.output_tokens ?? 0,
  }
  if (wire.cache_read_input_tokens !== undefined)
    usage.cacheReadTokens = wire.cache_read_input_tokens
  if (wire.cache_creation_input_tokens !== undefined) {
    usage.cacheCreationTokens = wire.cache_creation_input_tokens
  }
  if (wire.cache_creation) {
    usage.cacheBreakdown = {
      fiveMinute: wire.cache_creation.ephemeral_5m_input_tokens,
      oneHour: wire.cache_creation.ephemeral_1h_input_tokens,
    }
  }
  if (wire.output_tokens_details?.thinking_tokens !== undefined) {
    usage.reasoningTokens = wire.output_tokens_details.thinking_tokens
  }
  if (wire.server_tool_use?.web_search_requests !== undefined) {
    usage.webSearchRequests = wire.server_tool_use.web_search_requests
  }
  return usage
}

function mergeUsageInPlace(prev: CanonicalUsage, delta: CanonicalUsage): CanonicalUsage {
  return {
    inputTokens: Math.max(prev.inputTokens, delta.inputTokens),
    outputTokens: Math.max(prev.outputTokens, delta.outputTokens),
    cacheReadTokens: maxDefined(prev.cacheReadTokens, delta.cacheReadTokens),
    cacheCreationTokens: maxDefined(prev.cacheCreationTokens, delta.cacheCreationTokens),
    cacheBreakdown: delta.cacheBreakdown ?? prev.cacheBreakdown,
    reasoningTokens: maxDefined(prev.reasoningTokens, delta.reasoningTokens),
    webSearchRequests: maxDefined(prev.webSearchRequests, delta.webSearchRequests),
  }
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined
  return Math.max(a ?? 0, b ?? 0)
}

function mapStopReason(raw: string | null): StopReason | null {
  switch (raw) {
    case null:
      return null
    case "end_turn":
      return "end_turn"
    case "tool_use":
      return "tool_use"
    case "max_tokens":
      return "max_tokens"
    case "stop_sequence":
      return "stop_sequence"
    case "refusal":
      return "refusal"
    case "pause_turn":
      return "pause_turn"
    case "model_context_window_exceeded":
      return "context_window_exceeded"
    default:
      return "error"
  }
}

function categorizeUpstream(
  errType: string,
): "overloaded" | "api" | "timeout" | "rate_limit" | "canceled" | "auth" | "unknown" {
  if (errType === "overloaded_error") return "overloaded"
  if (errType === "api_error") return "api"
  if (errType === "rate_limit_error") return "rate_limit"
  if (errType === "authentication_error" || errType === "invalid_api_key") return "auth"
  return "unknown"
}

function isRetryableErrorCategory(errType: string): boolean {
  // rate_limit_error is retryable: the outer coordinator waits the window
  // out on the slow curve rather than stopping the agent.
  return errType === "overloaded_error" || errType === "api_error" || errType === "rate_limit_error"
}

/**
 * OpenAI Responses API SSE → CanonicalEvent translator.
 *
 * The Responses API streams a typed event union (not the
 * delta-merging shape Chat Completions uses). Each event has a
 * `type` discriminator like `"response.created"`,
 * `"response.output_text.delta"`, `"response.completed"`.
 *
 * Reference: https://platform.openai.com/docs/api-reference/responses-streaming
 *
 * We track:
 * - `response.created` → `MessageStartEvent`
 * - `response.content_part.added type:"output_text"` → `TextStartEvent`
 * - `response.output_text.delta` → `TextDeltaEvent`
 * - `response.output_text.done` / `response.content_part.done` → `TextStopEvent`
 * - `response.output_item.added type:"reasoning"` (or first
 *   `response.reasoning_summary_text.delta`) → `ThinkingStartEvent`
 * - `response.reasoning_summary_text.delta` → `ThinkingDeltaEvent`
 * - `response.reasoning_summary_text.done` → `ThinkingStopEvent`
 * - `response.output_item.added type:"function_call"` → `ToolUseStartEvent`
 * - `response.function_call_arguments.delta` → `ToolUseInputDeltaEvent`
 * - `response.function_call_arguments.done` → `ToolUseStopEvent`
 * - `response.refusal.delta` → `RefusalDeltaEvent`
 * - `response.completed` → `MessageDeltaEvent` + `MessageStopEvent`
 * - `response.failed` / `response.incomplete` → `MessageDeltaEvent` (error)
 * - `error` → `StreamErrorEvent`
 *
 * @module llm/providers/openai/responses/response-stream
 */

import type { CanonicalEvent, CanonicalUsage, StopReason } from "../../../src/llm/canonical-events.ts"
import { classifyUpstreamError } from "../../../src/llm/errors.ts"

// ---------------------------------------------------------------------------
// Wire types (subset we consume)
// ---------------------------------------------------------------------------

export interface OpenAIResponsesEventBase {
  type: string
}

interface ResponseCreated extends OpenAIResponsesEventBase {
  type: "response.created" | "response.in_progress"
  response: {
    id: string
    model: string
    status?: string
    usage?: OpenAIResponsesUsage
  }
}

interface OutputItemAdded extends OpenAIResponsesEventBase {
  type: "response.output_item.added"
  output_index: number
  item: {
    type: "message" | "function_call" | "reasoning"
    id?: string
    role?: string
    call_id?: string
    name?: string
    arguments?: string
  }
}

interface OutputItemDone extends OpenAIResponsesEventBase {
  type: "response.output_item.done"
  output_index: number
  item: OutputItemAdded["item"]
}

interface ContentPartAdded extends OpenAIResponsesEventBase {
  type: "response.content_part.added"
  output_index: number
  content_index: number
  item_id: string
  part: { type: "output_text" | "refusal" | (string & {}); text?: string }
}

interface ContentPartDone extends OpenAIResponsesEventBase {
  type: "response.content_part.done"
  output_index: number
  content_index: number
  item_id: string
  part: { type: string; text?: string }
}

interface OutputTextDelta extends OpenAIResponsesEventBase {
  type: "response.output_text.delta"
  output_index: number
  content_index: number
  item_id: string
  delta: string
}

interface OutputTextDone extends OpenAIResponsesEventBase {
  type: "response.output_text.done"
  output_index: number
  content_index: number
  item_id: string
  text: string
}

interface RefusalDelta extends OpenAIResponsesEventBase {
  type: "response.refusal.delta"
  output_index: number
  content_index: number
  item_id: string
  delta: string
}

interface FunctionCallArgumentsDelta extends OpenAIResponsesEventBase {
  type: "response.function_call_arguments.delta"
  output_index: number
  item_id: string
  delta: string
}

interface FunctionCallArgumentsDone extends OpenAIResponsesEventBase {
  type: "response.function_call_arguments.done"
  output_index: number
  item_id: string
  arguments: string
}

interface ReasoningSummaryTextDelta extends OpenAIResponsesEventBase {
  type: "response.reasoning_summary_text.delta"
  output_index: number
  summary_index: number
  item_id: string
  delta: string
}

interface ReasoningSummaryTextDone extends OpenAIResponsesEventBase {
  type: "response.reasoning_summary_text.done"
  output_index: number
  summary_index: number
  item_id: string
  text: string
}

interface ResponseCompleted extends OpenAIResponsesEventBase {
  type: "response.completed"
  response: {
    id: string
    status: "completed"
    usage?: OpenAIResponsesUsage
  }
}

interface ResponseFailed extends OpenAIResponsesEventBase {
  type: "response.failed"
  response: { id: string; status: "failed"; error?: { code?: string; message?: string } }
}

interface ResponseIncomplete extends OpenAIResponsesEventBase {
  type: "response.incomplete"
  response: {
    id: string
    status: "incomplete"
    incomplete_details?: { reason?: string }
    usage?: OpenAIResponsesUsage
  }
}

interface ErrorEvent extends OpenAIResponsesEventBase {
  type: "error"
  error?: { code?: string; message?: string }
}

export type OpenAIResponsesEvent =
  | ResponseCreated
  | OutputItemAdded
  | OutputItemDone
  | ContentPartAdded
  | ContentPartDone
  | OutputTextDelta
  | OutputTextDone
  | RefusalDelta
  | FunctionCallArgumentsDelta
  | FunctionCallArgumentsDone
  | ReasoningSummaryTextDelta
  | ReasoningSummaryTextDone
  | ResponseCompleted
  | ResponseFailed
  | ResponseIncomplete
  | ErrorEvent
  | OpenAIResponsesEventBase // catch-all for future event types

interface OpenAIResponsesUsage {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number }
  total_tokens?: number
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

/**
 * Yield canonical events from a stream of Responses API events.
 *
 * Block-index assignment: we mint a fresh sequential index for each
 * (output_index, content_index | summary_index) tuple so the canonical
 * consumer's "one open block at a time" assumption holds across the
 * interleaved reasoning/message/function-call items.
 *
 * @yields Canonical events translated from each Responses API event.
 */
export async function* translateOpenAIResponsesStream(
  events: AsyncIterable<OpenAIResponsesEvent>,
): AsyncIterable<CanonicalEvent> {
  let messageStartEmitted = false
  let lastUsage: CanonicalUsage = { inputTokens: 0, outputTokens: 0 }
  let stopReason: StopReason | null = null
  let nextBlockIndex = 0
  // (item_id + part-suffix) → canonical block index
  const textBlocks = new Map<string, number>()
  const reasoningBlocks = new Map<string, number>()
  const functionBlocks = new Map<string, number>()

  for await (const ev of events) {
    switch (ev.type) {
      case "response.created":
      case "response.in_progress": {
        const created = ev as ResponseCreated
        if (!messageStartEmitted) {
          messageStartEmitted = true
          if (created.response.usage) lastUsage = mapUsage(created.response.usage)
          yield {
            type: "message_start",
            messageId: created.response.id,
            modelId: created.response.model,
            initialUsage: lastUsage,
          }
        }
        break
      }
      case "response.output_item.added": {
        const added = ev as OutputItemAdded
        if (added.item.type === "function_call") {
          const key = `${added.output_index}:${added.item.id ?? added.item.call_id ?? ""}`
          const idx = nextBlockIndex++
          functionBlocks.set(key, idx)
          yield {
            type: "tool_use_start",
            index: idx,
            id: added.item.call_id ?? added.item.id ?? `call_${idx}`,
            name: added.item.name ?? "unknown",
          }
        } else if (added.item.type === "reasoning") {
          const key = `${added.output_index}:${added.item.id ?? "reasoning"}`
          const idx = nextBlockIndex++
          reasoningBlocks.set(key, idx)
          yield { type: "thinking_start", index: idx }
        }
        break
      }
      case "response.output_item.done": {
        const done = ev as OutputItemDone
        if (done.item.type === "function_call") {
          const key = `${done.output_index}:${done.item.id ?? done.item.call_id ?? ""}`
          const blockIdx = functionBlocks.get(key)
          if (blockIdx !== undefined) {
            let input: unknown
            const raw = done.item.arguments ?? ""
            try {
              input = raw ? JSON.parse(raw) : {}
            } catch {
              input = { _raw: raw }
            }
            yield { type: "tool_use_stop", index: blockIdx, input }
            functionBlocks.delete(key)
          }
        }
        break
      }
      case "response.content_part.added": {
        const added = ev as ContentPartAdded
        if (added.part.type === "output_text") {
          const key = `${added.item_id}:${added.output_index}:${added.content_index}`
          const idx = nextBlockIndex++
          textBlocks.set(key, idx)
          yield { type: "text_start", index: idx }
          if (added.part.text) {
            yield { type: "text_delta", index: idx, text: added.part.text }
          }
        }
        break
      }
      case "response.content_part.done": {
        const done = ev as ContentPartDone
        const key = `${done.item_id}:${done.output_index}:${done.content_index}`
        const idx = textBlocks.get(key)
        if (idx !== undefined && done.part.type === "output_text") {
          yield { type: "text_stop", index: idx, finalText: done.part.text }
          textBlocks.delete(key)
        }
        break
      }
      case "response.output_text.delta": {
        const delta = ev as OutputTextDelta
        const key = `${delta.item_id}:${delta.output_index}:${delta.content_index}`
        const idx = textBlocks.get(key)
        if (idx !== undefined) {
          yield { type: "text_delta", index: idx, text: delta.delta }
        }
        break
      }
      case "response.output_text.done": {
        const done = ev as OutputTextDone
        const key = `${done.item_id}:${done.output_index}:${done.content_index}`
        const idx = textBlocks.get(key)
        if (idx !== undefined) {
          yield { type: "text_stop", index: idx, finalText: done.text }
        }
        break
      }
      case "response.refusal.delta": {
        const r = ev as RefusalDelta
        yield { type: "refusal_delta", text: r.delta }
        break
      }
      case "response.function_call_arguments.delta": {
        const d = ev as FunctionCallArgumentsDelta
        // Match by item_id (output_index alone isn't always reliable when
        // multiple function calls coexist).
        for (const [k, idx] of functionBlocks.entries()) {
          if (k.endsWith(`:${d.item_id}`)) {
            yield { type: "tool_use_input_delta", index: idx, partialJson: d.delta }
            break
          }
        }
        break
      }
      case "response.function_call_arguments.done": {
        // Final aggregated arguments — the corresponding `output_item.done`
        // will emit the canonical tool_use_stop with parsed input. We can
        // still surface the final partial here as a delta for consumers
        // that didn't accumulate. (Idempotent: the stop event re-parses.)
        const d = ev as FunctionCallArgumentsDone
        for (const [k, idx] of functionBlocks.entries()) {
          if (k.endsWith(`:${d.item_id}`)) {
            // No-op: the cumulative deltas already covered this. The
            // final wire `done` event has the same text concatenated.
            void idx
            break
          }
        }
        break
      }
      case "response.reasoning_summary_text.delta": {
        const d = ev as ReasoningSummaryTextDelta
        // Find the matching reasoning block.
        for (const [k, idx] of reasoningBlocks.entries()) {
          if (k.endsWith(`:${d.item_id}`)) {
            yield { type: "thinking_delta", index: idx, text: d.delta }
            break
          }
        }
        break
      }
      case "response.reasoning_summary_text.done": {
        const d = ev as ReasoningSummaryTextDone
        for (const [k, idx] of reasoningBlocks.entries()) {
          if (k.endsWith(`:${d.item_id}`)) {
            yield { type: "thinking_stop", index: idx }
            reasoningBlocks.delete(k)
            break
          }
        }
        break
      }
      case "response.completed": {
        const c = ev as ResponseCompleted
        if (c.response.usage) lastUsage = mergeUsageMax(lastUsage, mapUsage(c.response.usage))
        // Default to end_turn unless we saw function_calls — but Responses
        // doesn't fire a separate `finish_reason`; the items themselves
        // tell us. If any function calls remain in `functionBlocks`, infer
        // tool_use.
        stopReason = functionBlocks.size > 0 ? "tool_use" : "end_turn"
        break
      }
      case "response.failed": {
        const f = ev as ResponseFailed
        stopReason = "error"
        const code = f.response.error?.code
        const { streamErrorType, category, retryable } = classifyUpstreamError({
          upstreamCode: code,
        })
        yield {
          type: "stream_error",
          retryable,
          category,
          upstreamType: streamErrorType,
          cause: new Error(
            `OpenAI Responses failed: ${code ?? "unknown"} — ${f.response.error?.message ?? ""}`,
          ),
        }
        break
      }
      case "response.incomplete": {
        const i = ev as ResponseIncomplete
        if (i.response.usage) lastUsage = mergeUsageMax(lastUsage, mapUsage(i.response.usage))
        const reason = i.response.incomplete_details?.reason
        stopReason =
          reason === "max_output_tokens"
            ? "max_tokens"
            : reason === "content_filter"
              ? "refusal"
              : "error"
        break
      }
      case "error": {
        const e = ev as ErrorEvent
        const code = e.error?.code
        const { streamErrorType, category, retryable } = classifyUpstreamError({
          upstreamCode: code,
        })
        yield {
          type: "stream_error",
          retryable,
          category,
          upstreamType: streamErrorType,
          cause: new Error(
            `OpenAI Responses error: ${code ?? "unknown"} — ${e.error?.message ?? ""}`,
          ),
        }
        break
      }
      // Ignore other event types (ping, audio, etc.) silently.
      default:
        break
    }
  }

  yield {
    type: "message_delta",
    stopReason,
    stopDetails: null,
    usage: lastUsage,
  }
  yield { type: "message_stop" }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapUsage(usage: OpenAIResponsesUsage): CanonicalUsage {
  const out: CanonicalUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  }
  if (usage.input_tokens_details?.cached_tokens !== undefined) {
    out.cacheReadTokens = usage.input_tokens_details.cached_tokens
  }
  if (usage.output_tokens_details?.reasoning_tokens !== undefined) {
    out.reasoningTokens = usage.output_tokens_details.reasoning_tokens
  }
  return out
}

function mergeUsageMax(a: CanonicalUsage, b: CanonicalUsage): CanonicalUsage {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadTokens:
      a.cacheReadTokens === undefined && b.cacheReadTokens === undefined
        ? undefined
        : Math.max(a.cacheReadTokens ?? 0, b.cacheReadTokens ?? 0),
    cacheCreationTokens: a.cacheCreationTokens ?? b.cacheCreationTokens,
    reasoningTokens:
      a.reasoningTokens === undefined && b.reasoningTokens === undefined
        ? undefined
        : Math.max(a.reasoningTokens ?? 0, b.reasoningTokens ?? 0),
    webSearchRequests: a.webSearchRequests ?? b.webSearchRequests,
  }
}

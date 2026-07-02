/**
 * OpenAI Chat Completions SSE → CanonicalEvent translator.
 *
 * Wire shape per chunk (the SSE `data:` JSON):
 *
 * ```
 *   {
 *     id: "chatcmpl-…",
 *     object: "chat.completion.chunk",
 *     created: <unix>,
 *     model: "gpt-4o",
 *     choices: [{
 *       index: 0,
 *       delta: {
 *         role?: "assistant",            // first chunk only
 *         content?: "Hello",             // text delta
 *         refusal?: "...",               // refusal delta
 *         tool_calls?: [{                // tool call delta
 *           index: 0,
 *           id?: "call_abc",             // first chunk for this index
 *           type?: "function",
 *           function: { name?, arguments? }
 *         }]
 *       },
 *       finish_reason: null | "stop" | "length" | "tool_calls" | "content_filter" | "function_call"
 *     }],
 *     usage?: {                          // final chunk (with stream_options.include_usage)
 *       prompt_tokens, completion_tokens, total_tokens,
 *       prompt_tokens_details: { cached_tokens },
 *       completion_tokens_details: { reasoning_tokens }
 *     }
 *   }
 * ```
 *
 * Stream ends with `data: [DONE]` (handled by the generic SSE parser).
 *
 * Provider-neutral: this is pure canonical↔OpenAI-chat-wire translation with
 * a single dependency on the canonical event contract. It lives in the leaf
 * package because it is reused by every OpenAI-compatible gateway provider
 * (openrouter, opencode, huggingface, wafer), not just the OpenAI adapter —
 * they all speak the OpenAI Chat Completions wire format. Wave G relocated it
 * here from `plugins/llm-openai/chat/response-stream.ts` (which now re-exports
 * this module) so the gateways vendor ONE shared translator instead of
 * cross-importing the openai plugin.
 *
 * @module llm/openai-chat
 */

import type { CanonicalEvent, CanonicalUsage, StopReason } from "./canonical-events.ts"

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface OpenAIChatChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: "assistant"
      content?: string | null
      refusal?: string | null
      /** DeepSeek-style chain-of-thought reasoning. */
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: "function"
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

/**
 * Yield canonical events from a stream of OpenAI Chat chunks.
 *
 * Maintains:
 * - Synthesized `message_start` on the first chunk (Chat doesn't send
 *   one explicitly; we mint a `msg_chatcmpl-…` id from the chunk id).
 * - Per-tool-call accumulation by `tool_calls[i].index`. First chunk
 *   for an index carries `id` + `function.name`; subsequent chunks
 *   stream `function.arguments` fragments.
 * - One text "block" for all content deltas (Chat has no separate
 *   start/stop markers within the assistant message).
 * - finish_reason → canonical StopReason.
 * - Final usage chunk (`choices: []` + `usage`) → MessageDeltaEvent.
 *
 * @yields Canonical events translated from each Chat Completions chunk.
 */
export async function* translateOpenAIChatStream(
  chunks: AsyncIterable<OpenAIChatChunk>,
): AsyncIterable<CanonicalEvent> {
  let messageStartEmitted = false
  let textIndex: number | null = null
  let thinkingIndex: number | null = null
  // Index → block index for tool calls
  const toolBlockIndex = new Map<number, number>()
  const toolNames = new Map<number, string>()
  const toolJson = new Map<number, string>()
  let nextBlockIndex = 0
  let stopReason: StopReason | null = null
  let lastUsage: CanonicalUsage = { inputTokens: 0, outputTokens: 0 }
  let modelId: string | undefined

  for await (const chunk of chunks) {
    modelId ??= chunk.model
    if (!messageStartEmitted) {
      messageStartEmitted = true
      yield {
        type: "message_start",
        messageId: chunk.id,
        modelId: chunk.model,
        initialUsage: lastUsage,
      }
    }

    // Capture usage from any chunk that has it. Some OpenAI-compatible APIs
    // (OpenCode Go, DeepSeek) send usage in the same chunk as the final
    // finish_reason/choice rather than a separate usage-only chunk.
    if (chunk.usage) {
      lastUsage = mapUsage(chunk.usage)
    }

    // Usage-only trailing chunk (OpenAI standard): choices empty, usage set.
    if (chunk.choices.length === 0 && chunk.usage) {
      continue
    }

    const choice = chunk.choices[0]
    if (!choice) continue

    const delta = choice.delta ?? {}

    // Text content
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (textIndex === null) {
        textIndex = nextBlockIndex++
        yield { type: "text_start", index: textIndex }
      }
      yield { type: "text_delta", index: textIndex, text: delta.content }
    }

    // Refusal content
    if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
      yield { type: "refusal_delta", text: delta.refusal }
    }

    // Reasoning content (DeepSeek-style thinking). Streamed as thinking
    // blocks — `reasoning_content` is the model's internal chain-of-thought.
    if (delta.reasoning_content !== undefined) {
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        if (thinkingIndex === null) {
          thinkingIndex = nextBlockIndex++
          yield { type: "thinking_start", index: thinkingIndex }
        }
        yield { type: "thinking_delta", index: thinkingIndex, text: delta.reasoning_content }
      } else if (thinkingIndex !== null) {
        yield { type: "thinking_stop", index: thinkingIndex }
        thinkingIndex = null
      }
    }

    // Tool call deltas
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        // First chunk for this tool-call index: open the block.
        if (!toolBlockIndex.has(tc.index)) {
          const blockIdx = nextBlockIndex++
          toolBlockIndex.set(tc.index, blockIdx)
          toolJson.set(tc.index, "")
          const id = tc.id ?? `call_${tc.index}`
          const name = tc.function?.name ?? "unknown"
          toolNames.set(tc.index, name)
          yield { type: "tool_use_start", index: blockIdx, id, name }
        }
        // Stream the function name if it lands late (rare).
        if (tc.function?.name && toolNames.get(tc.index) === "unknown") {
          toolNames.set(tc.index, tc.function.name)
        }
        // Stream the arguments JSON fragment.
        if (tc.function?.arguments) {
          const blockIdx = toolBlockIndex.get(tc.index) ?? -1
          toolJson.set(tc.index, (toolJson.get(tc.index) ?? "") + tc.function.arguments)
          yield {
            type: "tool_use_input_delta",
            index: blockIdx,
            partialJson: tc.function.arguments,
          }
        }
      }
    }

    // Finish reason → close any open blocks + record stop reason.
    if (choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason)
      if (thinkingIndex !== null) {
        yield { type: "thinking_stop", index: thinkingIndex }
        thinkingIndex = null
      }
      if (textIndex !== null) {
        yield { type: "text_stop", index: textIndex }
        textIndex = null
      }
      // Close any open tool_use blocks with their parsed input.
      for (const [tcIndex, blockIdx] of toolBlockIndex.entries()) {
        const raw = toolJson.get(tcIndex) ?? ""
        let input: unknown
        try {
          input = raw ? JSON.parse(raw) : {}
        } catch {
          input = { _raw: raw }
        }
        yield { type: "tool_use_stop", index: blockIdx, input }
      }
      toolBlockIndex.clear()
      toolJson.clear()
      toolNames.clear()
    }
  }

  // Emit the terminal MessageDeltaEvent + MessageStopEvent.
  yield {
    type: "message_delta",
    stopReason,
    stopDetails: stopReason === "refusal" ? { type: "content_filter" } : null,
    usage: lastUsage,
  }
  yield { type: "message_stop" }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapUsage(usage: NonNullable<OpenAIChatChunk["usage"]>): CanonicalUsage {
  const out: CanonicalUsage = {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  }
  if (usage.prompt_tokens_details?.cached_tokens !== undefined) {
    out.cacheReadTokens = usage.prompt_tokens_details.cached_tokens
  }
  if (usage.completion_tokens_details?.reasoning_tokens !== undefined) {
    out.reasoningTokens = usage.completion_tokens_details.reasoning_tokens
  }
  return out
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool_calls":
    case "function_call":
      return "tool_use"
    case "content_filter":
      return "refusal"
    default:
      return "error"
  }
}

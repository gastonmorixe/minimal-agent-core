/**
 * Ollama native /api/chat NDJSON stream to CanonicalEvent translator.
 *
 * Ollama streams newline-delimited JSON (NDJSON), one object per line, NOT
 * SSE. Each object is an {@link OllamaChatChunk}:
 *
 * ```json
 * {"model":"deepseek-v4-flash","created_at":"...",
 *  "message":{"role":"assistant","content":"Hel","thinking":"..."},"done":false}
 * ```
 *
 * The terminal object carries `done:true`, a `done_reason`, and usage counters:
 *
 * ```json
 * {"model":"...","message":{"role":"assistant","content":""},
 *  "done":true,"done_reason":"stop",
 *  "prompt_eval_count":26,"eval_count":298}
 * ```
 *
 * Tool calls arrive whole (not streamed as partial JSON) on a chunk's
 * `message.tool_calls[]`, each `{function:{name, arguments:{...}}}`. Ollama's
 * native protocol assigns NO id to a tool call, so this translator mints a
 * clean, monotonic one (see the id contract note at the tool-call site).
 *
 * This module owns both the NDJSON line parser ({@link parseNdjson}) and the
 * canonical translation. It shares no code with the SSE-based providers.
 *
 * @module llm/providers/ollama/response-stream
 */

import type {
  CanonicalEvent,
  CanonicalUsage,
  StopReason,
} from "@minimal-agent/plugin-api/llm/canonical-events"

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface OllamaToolCallWire {
  function?: {
    name?: string
    arguments?: Record<string, unknown> | string
  }
}

export interface OllamaChatChunk {
  model?: string
  created_at?: string
  message?: {
    role?: string
    content?: string
    thinking?: string
    tool_calls?: OllamaToolCallWire[]
  }
  done?: boolean
  done_reason?: string
  /** Input token count (final chunk). */
  prompt_eval_count?: number
  /** Output token count (final chunk). */
  eval_count?: number
  /** Top-level error string (Ollama reports errors inline on a 200 stream). */
  error?: string
}

// ---------------------------------------------------------------------------
// NDJSON parser
// ---------------------------------------------------------------------------

/**
 * Yield each JSON object from a newline-delimited-JSON
 * `ReadableStream<Uint8Array>`. Line-buffered: accumulates bytes until a
 * newline, parses the complete line. Tolerates partial chunks (one JSON object
 * split across TCP segments) and a trailing object with no final newline.
 *
 * @typeParam T - Shape of each parsed line object.
 */
export async function* parseNdjson<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const MAX_BUFFER_LENGTH = 5 * 1024 * 1024 // 5MB guard against a runaway line

  const emit = function* (line: string): Generator<T> {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      yield JSON.parse(trimmed) as T
    } catch {
      // skip a malformed line; defensive
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_BUFFER_LENGTH) {
        throw new Error(`stream_error: NDJSON line exceeded ${MAX_BUFFER_LENGTH} bytes`)
      }
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        yield* emit(line)
      }
    }
    // Flush any trailing object with no terminating newline.
    yield* emit(buffer)
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

/**
 * Translate a stream of Ollama chat chunks into canonical events.
 *
 * Maintains:
 * - A synthesized `message_start` on the first chunk (Ollama sends no explicit
 *   start; a `msg_<n>` id is minted).
 * - One thinking block for `message.thinking` deltas and one text block for
 *   `message.content` deltas. Ollama interleaves them; thinking always precedes
 *   content for a given turn, so the thinking block closes when content begins.
 * - Tool calls: each `message.tool_calls[]` entry opens + immediately closes a
 *   `tool_use` block (arguments arrive whole, so a single
 *   `tool_use_input_delta` carries the full JSON).
 * - `done:true` to a final `message_delta` with stop reason + usage, then
 *   `message_stop`.
 * - An inline `error` string to a retryable-classified `stream_error`.
 *
 * @yields Canonical events translated from each Ollama chunk.
 */
export async function* translateOllamaStream(
  chunks: AsyncIterable<OllamaChatChunk>,
): AsyncIterable<CanonicalEvent> {
  let started = false
  let textIndex: number | null = null
  let thinkingIndex: number | null = null
  let nextBlockIndex = 0
  let stopReason: StopReason | null = null
  let usage: CanonicalUsage = { inputTokens: 0, outputTokens: 0 }
  let sawToolCall = false
  // Monotonic counter for minting clean, regex-safe tool-call ids. Spans the
  // whole stream so multiple tool calls across chunks never collide.
  let toolCallSeq = 0

  for await (const chunk of chunks) {
    if (chunk.error) {
      yield {
        type: "stream_error",
        retryable: true,
        category: "api",
        upstreamType: "ollama_error",
        cause: new Error(chunk.error),
      }
      continue
    }

    if (!started) {
      started = true
      yield {
        type: "message_start",
        messageId: `msg_${toolCallSeq}_${chunk.eval_count ?? 0}`,
        modelId: chunk.model ?? "ollama",
        initialUsage: usage,
      }
    }

    const msg = chunk.message
    if (msg) {
      // Thinking trace.
      if (typeof msg.thinking === "string" && msg.thinking.length > 0) {
        if (thinkingIndex === null) {
          thinkingIndex = nextBlockIndex++
          yield { type: "thinking_start", index: thinkingIndex }
        }
        yield { type: "thinking_delta", index: thinkingIndex, text: msg.thinking }
      }

      // Visible content. Close any open thinking block first.
      if (typeof msg.content === "string" && msg.content.length > 0) {
        if (thinkingIndex !== null) {
          yield { type: "thinking_stop", index: thinkingIndex }
          thinkingIndex = null
        }
        if (textIndex === null) {
          textIndex = nextBlockIndex++
          yield { type: "text_start", index: textIndex }
        }
        yield { type: "text_delta", index: textIndex, text: msg.content }
      }

      // Tool calls (whole, not streamed in fragments).
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        if (thinkingIndex !== null) {
          yield { type: "thinking_stop", index: thinkingIndex }
          thinkingIndex = null
        }
        sawToolCall = true
        for (const tc of msg.tool_calls) {
          const blockIdx = nextBlockIndex++
          const name = tc.function?.name ?? "unknown"
          // Ollama assigns NO id to a tool call, so mint a monotonic one. It
          // MUST satisfy the host's tool_use-id contract (a 1-64 char string of
          // letters, digits, underscore, and dash). A plain call_<n> counter
          // does; an earlier created_at-based id embedded ISO colons and dots
          // and overran 64 chars, which the agent rejected as "Invalid
          // tool_use id or name".
          const id = `call_${toolCallSeq++}`
          const args = normalizeArgs(tc.function?.arguments)
          yield { type: "tool_use_start", index: blockIdx, id, name }
          yield { type: "tool_use_input_delta", index: blockIdx, partialJson: JSON.stringify(args) }
          yield { type: "tool_use_stop", index: blockIdx, input: args }
        }
      }
    }

    if (chunk.done) {
      // Tool calls in the turn override the natural stop reason: the agent
      // loop must see `tool_use` to dispatch the calls.
      stopReason = sawToolCall ? "tool_use" : mapDoneReason(chunk.done_reason)
      usage = mapUsage(chunk)
      if (thinkingIndex !== null) {
        yield { type: "thinking_stop", index: thinkingIndex }
        thinkingIndex = null
      }
      if (textIndex !== null) {
        yield { type: "text_stop", index: textIndex }
        textIndex = null
      }
    }
  }

  // Close any still-open blocks defensively (stream ended without done:true).
  if (thinkingIndex !== null) yield { type: "thinking_stop", index: thinkingIndex }
  if (textIndex !== null) yield { type: "text_stop", index: textIndex }

  yield { type: "message_delta", stopReason, usage }
  yield { type: "message_stop" }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeArgs(
  args: Record<string, unknown> | string | undefined,
): Record<string, unknown> {
  if (args && typeof args === "object") return args
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args)
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
    } catch {
      // fall through
    }
  }
  return {}
}

function mapUsage(chunk: OllamaChatChunk): CanonicalUsage {
  return {
    inputTokens: chunk.prompt_eval_count ?? 0,
    outputTokens: chunk.eval_count ?? 0,
  }
}

/**
 * Map Ollama's `done_reason` onto a canonical stop reason. Ollama uses `"stop"`
 * (natural end) and `"length"` (hit num_predict); tool calls flip the stop
 * reason to `tool_use` at the call site. Defaults to `end_turn`.
 */
function mapDoneReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "length":
      return "max_tokens"
    default:
      return "end_turn"
  }
}

/**
 * Canonical-events → legacy-stream bridge.
 *
 * Split from `adapter-legacy.ts` to keep that file under the repo's
 * 810-line cap (see .oxlintrc.json `max-lines`). This module owns the
 * single async-generator bridge `canonicalEventsToLegacyStream` plus its
 * private helpers; `adapter-legacy.ts` re-exports the public surface so
 * existing import paths keep working.
 *
 * @module llm/adapter-legacy-stream
 */

import type { CanonicalEvent, CanonicalUsage } from "./canonical-events.ts"
import type { ContentBlock as LegacyContentBlock } from "./messages.ts"
import {
  type AttemptProgress,
  attachAttemptProgress,
  ZERO_ATTEMPT_PROGRESS,
} from "./transport/attempt-progress.ts"
import {
  emitOutputEnd,
  getStreamDeltaAccumulator,
  resetStreamDeltaAccumulator,
} from "./transport/stream-delta.ts"
import type { StreamedResponse as LegacyStreamedResponse } from "./transport/types.ts"

/** Lifecycle hooks the legacy stream fires as side-channels (not yielded). */
export interface LegacyStreamCallbacks {
  onThinkingStart?: () => void | Promise<void>
  onThinkingDelta?: (text: string) => void | Promise<void>
  onThinkingStop?: () => void | Promise<void>
  onTextStop?: () => void | Promise<void>
  /**
   * Fired once with the message_start usage snapshot (the input/cache
   * footprint), mirroring where the legacy client calls `addSessionUsage`.
   * The transport wires this to the session-token + quota buses.
   */
  onUsage?: (usage: CanonicalUsage) => void
}

/** Best-effort JSON parse of an accumulated tool-input fragment. */
function safeParseToolInput(json: string): Record<string, unknown> {
  if (json.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Re-shape a canonical `StreamErrorEvent` into the tagged `Error` the legacy
 * retry classifier understands (`streamErrorType`). The raw Phase-1 transport
 * has no retry loop, so this just throws; the Phase-2 retry middleware
 * intercepts `stream_error` events upstream and never lets them reach here.
 *
 * Always attaches {@link AttemptProgress} so terminal-less recovery can see
 * whether any complete tool call already landed (the post-tool replay ban).
 */
function taggedStreamError(
  ev: Extract<CanonicalEvent, { type: "stream_error" }>,
  progress: AttemptProgress,
): Error {
  const byCategory: Record<string, string> = {
    overloaded: "overloaded_error",
    api: "api_error",
    timeout: "stream_idle",
    rate_limit: "rate_limit_error",
    // `insufficient_quota` is in neither retryable set, so even without the
    // retryable:false override below it would propagate — but the precise tag
    // keeps the diag line honest ("insufficient_quota", not "unknown_error").
    billing: "insufficient_quota",
    auth: "authentication_error",
    canceled: "request_canceled",
    unknown: "unknown_error",
  }
  // Prefer the verbatim upstream type so the retry classifier sees the exact
  // provider code (e.g. `rate_limit_error`) rather than a lossy category
  // remap. Fall back to the category map for synthetic / category-only errors.
  const streamErrorType = ev.upstreamType ?? byCategory[ev.category ?? "unknown"] ?? "unknown_error"
  const err = (
    ev.cause instanceof Error
      ? ev.cause
      : new Error(`canonical stream error: ${ev.category ?? "unknown"}`)
  ) as Error & { streamErrorType?: string; retryable?: boolean }
  if (err.streamErrorType === undefined) err.streamErrorType = streamErrorType
  // Carry the provider's explicit non-retryable verdict onto the thrown
  // error. The category→streamErrorType fallback above can map a terminal
  // failure (e.g. a billing error with category "billing") onto a tag that
  // happens to live in a retryable set; `retryable: false` is the
  // authoritative override the retry classifier honors so it propagates.
  if (ev.retryable === false) err.retryable = false
  return attachAttemptProgress(err, { ...progress })
}

/**
 * Consume a canonical event stream and re-emit the legacy transport
 * contract: YIELD text deltas (text channel only : thinking flows via the
 * `onThinkingDelta` callback, never the yield channel), fire the lifecycle
 * callbacks in stream order, accumulate structured blocks, and RETURN the
 * final `StreamedResponse`.
 *
 * This is the exact surface `client.transport-contract.test.ts` pins for
 * the legacy `sendMessage`, so a canonical transport built on top of this
 * is observably interchangeable behind `Agent.sendFn`.
 *
 * @yields text deltas as they arrive (the legacy string channel).
 */
export async function* canonicalEventsToLegacyStream(
  events: AsyncIterable<CanonicalEvent>,
  cb: LegacyStreamCallbacks = {},
): AsyncGenerator<string, LegacyStreamedResponse, undefined> {
  const blocks: LegacyContentBlock[] = []
  let fullText = ""
  let stopReason: string | null = null
  let stopDetails: { type: string; message?: string } | null = null
  // Provider response id from `message_start`. Surfaced on the returned
  // StreamedResponse so a caller could thread it back via
  // `previous_response_id` (OpenAI Responses) — previously dropped here.
  let responseId: string | undefined
  // Billed usage for this turn, merged from the canonical usage snapshots
  // (initial at message_start, final at message_delta). Surfaced on the
  // returned StreamedResponse.usage so the agent loop persists the turn's
  // exact footprint via appendAssistant. Mirrors the legacy client path.
  let turnUsage: LegacyStreamedResponse["usage"]

  // Progress for terminal-less recovery. Completed tool calls are counted
  // only on `tool_use_stop` (fully assembled + closed), never on a partial
  // open tool_use or bare input deltas.
  let progress: AttemptProgress = { ...ZERO_ATTEMPT_PROGRESS }

  type Cur =
    | { kind: "text"; text: string }
    | { kind: "thinking"; thinking: string; signature: string }
    | { kind: "tool_use"; id: string; name: string; json: string }
    | null
  let cur: Cur = null

  const MAX_BLOCK_BYTES = 5 * 1024 * 1024 // 5MB cap
  const checkCap = (len: number, add: number) => {
    if (len + add > MAX_BLOCK_BYTES) {
      throw new Error(`stream_error: Block accumulated size exceeded ${MAX_BLOCK_BYTES} bytes cap`)
    }
  }

  const noteEvent = (type: CanonicalEvent["type"]) => {
    progress = { ...progress, lastEventType: type }
  }

  const flushCur = (opts?: { countCompletedTool?: boolean }) => {
    if (!cur) return
    if (cur.kind === "text") {
      // Drop empty/whitespace-only text blocks. The Anthropic API rejects
      // them ("messages: text content blocks must be non-empty"), and an
      // OpenAI-compatible provider (Ollama/OpenAI) emits a trailing empty
      // text block whenever it interleaves a `text_stop` after a `tool_use`
      // (the deferred-stop pattern in those translators). Persisting one
      // makes the SAME session fail to resume under Anthropic. The deltas
      // were already yielded to the consumer, so dropping the empty block
      // only keeps junk out of history.
      if (cur.text.trim().length > 0) blocks.push({ type: "text", text: cur.text })
    } else if (cur.kind === "thinking") {
      if (cur.signature) {
        blocks.push({
          type: "thinking",
          thinking: cur.thinking,
          signature: cur.signature,
        })
      }
    } else if (cur.kind === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: cur.id,
        name: cur.name,
        input: safeParseToolInput(cur.json),
      })
      if (opts?.countCompletedTool) {
        progress = {
          ...progress,
          completedToolCalls: progress.completedToolCalls + 1,
        }
      }
    }
    cur = null
  }

  // Streamed-output telemetry: every exit path (clean end, stream_error
  // throw, terminal-less recovery return) must drop the accumulator, or
  // the next send's first delta would reuse stale pending tokens from this
  // stream. `finally` guarantees it.
  try {
    for await (const ev of events) {
      noteEvent(ev.type)
      switch (ev.type) {
        case "message_start":
          // Anthropic reports the input/cache footprint at message_start (cache
          // lookup happens during prefill). Surface it on the same beat the
          // legacy client calls addSessionUsage.
          cb.onUsage?.(ev.initialUsage)
          turnUsage = canonicalUsageToWire(ev.initialUsage)
          // Capture the provider response id (OpenAI Responses `response.id`).
          // Kept on the returned StreamedResponse instead of being discarded.
          if (ev.messageId) {
            responseId = ev.messageId
            progress = { ...progress, responseId: ev.messageId }
          }
          break
        case "text_start":
          flushCur()
          cur = { kind: "text", text: "" }
          break
        case "text_delta":
          progress = { ...progress, sawText: true }
          checkCap(fullText.length, ev.text.length)
          if (cur?.kind === "text") {
            checkCap(cur.text.length, ev.text.length)
            cur.text += ev.text
          }
          fullText += ev.text
          getStreamDeltaAccumulator().add(ev.text.length)
          getStreamDeltaAccumulator().maybeFlush()
          yield ev.text
          break
        case "text_stop": {
          if (cur?.kind === "text") {
            // flushCur() drops empty/whitespace-only text (the API rejects it).
            flushCur()
          } else {
            // No open text block: this is the deferred-stop pattern where the
            // text was already flushed by an intervening tool_use/thinking
            // start (e.g. the Ollama translator emits text_stop in its `done`
            // handler, after the tool_use events). Only synthesize a block
            // from finalText when it carries real content; never push a `""`
            // block, which would 400 on the next Anthropic send / resume.
            const text = ev.finalText ?? ""
            if (text.trim().length > 0) {
              progress = { ...progress, sawText: true }
              blocks.push({ type: "text", text })
            }
          }
          await cb.onTextStop?.()
          break
        }
        case "thinking_start":
          flushCur()
          progress = { ...progress, sawReasoning: true }
          cur = { kind: "thinking", thinking: "", signature: "" }
          await cb.onThinkingStart?.()
          break
        case "thinking_delta":
          progress = { ...progress, sawReasoning: true }
          if (cur?.kind === "thinking") {
            checkCap(cur.thinking.length, ev.text.length)
            cur.thinking += ev.text
          }
          getStreamDeltaAccumulator().add(ev.text.length)
          getStreamDeltaAccumulator().maybeFlush()
          await cb.onThinkingDelta?.(ev.text)
          break
        case "thinking_signature":
          if (cur?.kind === "thinking") cur.signature = ev.signature
          break
        case "thinking_stop":
          if (cur?.kind === "thinking") flushCur()
          await cb.onThinkingStop?.()
          break
        case "tool_use_start":
          flushCur()
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(ev.id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(ev.name)) {
            throw new Error(`stream_error: Invalid tool_use id or name`)
          }
          cur = { kind: "tool_use", id: ev.id, name: ev.name, json: "" }
          break
        case "tool_use_input_delta":
          if (cur?.kind === "tool_use") {
            checkCap(cur.json.length, ev.partialJson.length)
            cur.json += ev.partialJson
          }
          break
        case "tool_use_stop": {
          // Only a closed tool_use is executable / counts as completed.
          if (cur?.kind === "tool_use") flushCur({ countCompletedTool: true })
          break
        }
        case "refusal_delta":
          // OpenAI surfaces refusals on a dedicated channel; fold into the
          // text stream so the legacy consumer doesn't silently drop it.
          progress = { ...progress, sawText: true }
          fullText += ev.text
          yield ev.text
          break
        case "message_delta":
          stopReason = ev.stopReason
          stopDetails = ev.stopDetails ?? null
          // The closing delta carries the merged usage (incl. the final
          // output_tokens). Overwrite so the persisted record holds the
          // authoritative billed footprint, not just the prefill counts.
          if (ev.usage) turnUsage = canonicalUsageToWire(ev.usage)
          break
        case "message_stop":
          // Final partial token batch: flushed by the finally below.
          break
        case "stream_error": {
          // Terminal-less EOF recovery (Grok/OpenAI Responses 200 SSE closed
          // without response.completed / failed / incomplete).
          //
          // Two salvage shapes — both avoid throwing into withRetry so the
          // agent can continue from local state instead of replaying a body:
          //
          //   1. completedToolCalls > 0: return tool_use with only closed tools
          //      (discard open partial tool_use). Agent executes tools once.
          //   2. sawText (no complete tools): return end_turn with partial text
          //      (discard open partial tool_use). Agent does a bounded local
          //      continuation (new body), not an identical re-POST.
          //
          // Empty / reasoning-only with no text still throws so withRetry can
          // take its one short pre-effect transport retry.
          const streamErrorType =
            ev.upstreamType ?? (ev.category === "api" ? "api_error" : undefined)
          if (streamErrorType === "stream_closed_without_terminal") {
            // Discard partial open tool_use — never execute incomplete calls.
            if (cur?.kind === "tool_use") cur = null

            if (progress.completedToolCalls > 0) {
              // Flush open text/thinking so history stays consistent with UI.
              if (cur?.kind === "text" || cur?.kind === "thinking") flushCur()
              else cur = null
              return {
                blocks,
                text: fullText,
                stopReason: "tool_use",
                stopDetails: {
                  type: "stream_closed_without_terminal",
                  message:
                    "Provider closed the stream without a terminal event after complete tool call(s); salvaged closed tools and continuing from local state",
                },
                usage: turnUsage,
                responseId,
              }
            }

            // Partial assistant TEXT only. Reasoning-only / empty still throw so
            // withRetry can take its one short pre-effect transport retry.
            // Do NOT treat thinking-only blocks as salvageable partial output.
            if (progress.sawText || fullText.trim().length > 0) {
              if (cur?.kind === "text" || cur?.kind === "thinking") flushCur()
              else cur = null
              return {
                blocks,
                text: fullText,
                stopReason: "end_turn",
                stopDetails: {
                  type: "stream_closed_without_terminal",
                  message:
                    "Provider closed the stream without a terminal event after partial output; preserved text and discarding incomplete tool calls",
                },
                usage: turnUsage,
                responseId,
              }
            }
          }
          throw taggedStreamError(ev, progress)
        }
        case "ping":
          // Keepalive / long-thinking activity — progress only, no failure.
          break
        default: {
          throw new Error(`unhandled canonical event: ${JSON.stringify(ev satisfies never)}`)
        }
      }
    }
  } finally {
    // Every exit path (clean end, stream_error throw, terminal-less
    // recovery return) must drop the accumulator, or the next send's first
    // delta would reuse stale pending tokens from this stream. Flush first
    // so subscribers receive the final partial window.
    getStreamDeltaAccumulator().flush()
    emitOutputEnd("stream_end")
    resetStreamDeltaAccumulator()
  }

  // Salvage a block left open when the stream ends without its closing
  // event. Mirrors the legacy client.ts fix: on `stop_reason: "max_tokens"`
  // the provider stops mid-block and never sends the matching `*_stop`, so
  // `cur` is still set here. Without this, a truncated tool_use (or text /
  // thinking) block was silently dropped and the agent loop mistook a
  // budget-capped turn for a clean finish. Finalize it the same way the
  // stop events do so the partial tool call still reaches the loop.
  //
  // NOTE: terminal-less closes with complete tools return earlier and do
  // NOT reach here with an open partial tool_use still set (discarded above).
  if (cur) {
    const wasTool = cur.kind === "tool_use"
    flushCur({ countCompletedTool: wasTool })
  }

  return {
    blocks,
    text: fullText,
    stopReason,
    stopDetails,
    usage: turnUsage,
    responseId,
  }
}

/**
 * Map a {@link CanonicalUsage} snapshot to the Anthropic-wire field names
 * used by `StreamedResponse.usage` / `AssistantRecord.usage`. Only the four
 * counters the session log persists are carried over; reasoning / web-search
 * counts are out of scope for the per-turn footprint. Returns `undefined`
 * when the snapshot is absent.
 */
function canonicalUsageToWire(u: CanonicalUsage | undefined): LegacyStreamedResponse["usage"] {
  if (!u) return undefined
  const wire: NonNullable<LegacyStreamedResponse["usage"]> = {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
  }
  if (u.cacheReadTokens !== undefined) wire.cache_read_input_tokens = u.cacheReadTokens
  if (u.cacheCreationTokens !== undefined) wire.cache_creation_input_tokens = u.cacheCreationTokens
  return wire
}

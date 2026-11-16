/**
 * Canonical event stream to {@link StreamedResponse}.
 *
 * The agent transport (`Agent.sendFn`) speaks one contract: yield text
 * deltas while the model streams, then return the assembled response
 * (content blocks, stop reason, usage). Every provider adapter emits
 * canonical events. This module turns those events into that contract.
 *
 * Concerns are split:
 *
 * 1. {@link ResponseBuilder} owns the response state: open block, closed
 *    blocks, full text, usage, and the recovery progress.
 * 2. {@link assembleStreamedResponse} is the event loop. It routes each
 *    event to the builder, fires the hooks, and yields text.
 * 3. Terminal-less recovery (a stream that closes without a terminal event)
 *    is one function, {@link salvageTerminalLess}.
 * 4. Usage mapping lives in `./usage-record.ts`.
 *
 * @module llm/codec/stream-assembler
 */

import type { PluginEventsPort } from "../../bus/plugin-events-port.ts"
import type { CanonicalEvent, CanonicalUsage } from "../canonical-events.ts"
import type { ContentBlock } from "../messages.ts"
import {
  type AttemptProgress,
  attachAttemptProgress,
  ZERO_ATTEMPT_PROGRESS,
} from "../transport/attempt-progress.ts"
import {
  emitOutputEnd,
  getStreamDeltaAccumulator,
  resetStreamDeltaAccumulator,
} from "../transport/stream-delta.ts"
import type { StreamBlockEdge, StreamedResponse } from "../transport/types.ts"

import { type UsageRecord, usageRecordFromCanonical } from "./usage-record.ts"

/** Side-channel hooks. None of them changes what is yielded or returned. */
export interface StreamAssemblerHooks {
  /** Thinking text. Thinking never goes on the yield channel. */
  onThinkingDelta?: (text: string) => void | Promise<void>
  /** A `text` or `thinking` block started or stopped. A stop fires after the block is stored. */
  onBlockEdge?: (edge: StreamBlockEdge) => void | Promise<void>
  /**
   * Live-output telemetry port (spec S28). Streamed-output progress reports
   * here. This module never reads a global bus pointer.
   */
  pluginEvents?: PluginEventsPort
}

/** Largest text, thinking, or tool-input size one block can reach. */
const MAX_BLOCK_BYTES = 5 * 1024 * 1024

/** Tool ids and names the wire accepts. */
const TOOL_IDENT = /^[a-zA-Z0-9_-]{1,64}$/

/** Fallback `streamErrorType` per canonical error category. */
const STREAM_ERROR_TYPE_BY_CATEGORY: Record<string, string> = {
  overloaded: "overloaded_error",
  api: "api_error",
  timeout: "stream_idle",
  rate_limit: "rate_limit_error",
  // Not in a retryable set, and precise in the diagnostics line.
  billing: "insufficient_quota",
  auth: "authentication_error",
  canceled: "request_canceled",
  unknown: "unknown_error",
}

type StreamErrorEvent = Extract<CanonicalEvent, { type: "stream_error" }>

type OpenBlock =
  | { kind: "text"; index: number; text: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "tool_use"; id: string; name: string; json: string }

/** Index used for the text block that collects refusal deltas. */
const REFUSAL_BLOCK_INDEX = -1

/** Best-effort JSON parse of an accumulated tool-input fragment. */
function parseToolInput(json: string): Record<string, unknown> {
  if (json.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function assertWithinCap(current: number, added: number): void {
  if (current + added > MAX_BLOCK_BYTES) {
    throw new Error(`stream_error: Block accumulated size exceeded ${MAX_BLOCK_BYTES} bytes cap`)
  }
}

/**
 * Final usage of one response. The closing snapshot wins field by field. A
 * field it omits keeps the `message_start` value. Anthropic sends the cache
 * TTL split only on `message_start`, so a plain overwrite loses it.
 */
function finalUsage(start: CanonicalUsage | undefined, end: CanonicalUsage): CanonicalUsage {
  if (!start) return end
  const merged: CanonicalUsage = { ...start }
  for (const [key, value] of Object.entries(end)) {
    if (value !== undefined) Object.assign(merged, { [key]: value })
  }
  return merged
}

/** Mutable state of the response under assembly. */
class ResponseBuilder {
  readonly blocks: ContentBlock[] = []
  text = ""
  stopReason: string | null = null
  stopDetails: { type: string; message?: string } | null = null
  responseId: string | undefined
  /** True once `message_stop` arrived: the response completed normally. */
  completed = false
  progress: AttemptProgress = { ...ZERO_ATTEMPT_PROGRESS }
  private open: OpenBlock | null = null
  private startUsage: CanonicalUsage | undefined
  private usage: CanonicalUsage | undefined
  /** Text block indexes already stored, so a late `text_stop` cannot add one twice. */
  private readonly storedTextIndexes = new Set<number>()

  get openKind(): OpenBlock["kind"] | undefined {
    return this.open?.kind
  }

  note(type: CanonicalEvent["type"]): void {
    this.progress = { ...this.progress, lastEventType: type }
  }

  start(ev: Extract<CanonicalEvent, { type: "message_start" }>): void {
    this.startUsage = ev.initialUsage
    this.usage = ev.initialUsage
    if (ev.messageId) {
      this.responseId = ev.messageId
      this.progress = { ...this.progress, responseId: ev.messageId }
    }
  }

  finish(ev: Extract<CanonicalEvent, { type: "message_delta" }>): void {
    this.stopReason = ev.stopReason
    this.stopDetails = ev.stopDetails ?? null
    if (ev.usage) this.usage = finalUsage(this.startUsage, ev.usage)
  }

  openText(index: number): void {
    this.close()
    this.open = { kind: "text", index, text: "" }
  }

  openThinking(): void {
    this.close()
    this.progress = { ...this.progress, sawReasoning: true }
    this.open = { kind: "thinking", thinking: "", signature: "" }
  }

  openToolUse(id: string, name: string): void {
    this.close()
    if (!TOOL_IDENT.test(id) || !TOOL_IDENT.test(name)) {
      throw new Error("stream_error: Invalid tool_use id or name")
    }
    this.open = { kind: "tool_use", id, name, json: "" }
  }

  /** Append visible text. Text with no open text block still counts for `text`. */
  appendText(text: string): void {
    this.progress = { ...this.progress, sawText: true }
    assertWithinCap(this.text.length, text.length)
    if (this.open?.kind === "text") {
      assertWithinCap(this.open.text.length, text.length)
      this.open.text += text
    }
    this.text += text
  }

  /** Refusal text goes to its own text block so it is stored, not only shown. */
  appendRefusal(text: string): void {
    if (this.open?.kind !== "text" || this.open.index !== REFUSAL_BLOCK_INDEX) {
      this.openText(REFUSAL_BLOCK_INDEX)
    }
    this.appendText(text)
  }

  appendThinking(text: string): void {
    this.progress = { ...this.progress, sawReasoning: true }
    if (this.open?.kind !== "thinking") return
    assertWithinCap(this.open.thinking.length, text.length)
    this.open.thinking += text
  }

  setSignature(signature: string): void {
    if (this.open?.kind === "thinking") this.open.signature = signature
  }

  appendToolInput(json: string): void {
    if (this.open?.kind !== "tool_use") return
    assertWithinCap(this.open.json.length, json.length)
    this.open.json += json
  }

  /**
   * Close a text block. With no open text block this is the deferred-stop
   * pattern: a later block start already stored the text. Use `finalText`
   * only when that index was never stored (no deltas arrived for it).
   */
  closeText(ev: Extract<CanonicalEvent, { type: "text_stop" }>): void {
    if (this.open?.kind === "text") {
      this.close()
      return
    }
    if (this.storedTextIndexes.has(ev.index)) return
    const text = ev.finalText ?? ""
    if (text.trim().length === 0) return
    this.progress = { ...this.progress, sawText: true }
    this.storeText(ev.index, text)
  }

  closeThinking(): void {
    if (this.open?.kind === "thinking") this.close()
  }

  /** Only a closed tool_use is executable, so only it counts as completed. */
  closeToolUse(): void {
    if (this.open?.kind === "tool_use") this.close({ countCompletedTool: true })
  }

  /** Drop an open tool_use without storing it. Never run a partial call. */
  discardOpenToolUse(): void {
    if (this.open?.kind === "tool_use") this.open = null
  }

  /**
   * Store the open block. Empty text is dropped: the Anthropic API rejects
   * it, and a stored one breaks resume. Thinking without a signature is
   * dropped: it cannot be sent back.
   */
  close(opts: { countCompletedTool?: boolean } = {}): void {
    const block = this.open
    this.open = null
    if (!block) return
    switch (block.kind) {
      case "text":
        if (block.text.trim().length > 0) this.storeText(block.index, block.text)
        break
      case "thinking":
        if (block.signature) {
          this.blocks.push({
            type: "thinking",
            thinking: block.thinking,
            signature: block.signature,
          })
        }
        break
      case "tool_use":
        this.blocks.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: parseToolInput(block.json),
        })
        if (opts.countCompletedTool) {
          this.progress = {
            ...this.progress,
            completedToolCalls: this.progress.completedToolCalls + 1,
          }
        }
        break
    }
  }

  usageRecord(): UsageRecord | undefined {
    return this.usage ? usageRecordFromCanonical(this.usage) : undefined
  }

  build(stop?: Pick<StreamedResponse, "stopReason" | "stopDetails">): StreamedResponse {
    return {
      blocks: this.blocks,
      text: this.text,
      stopReason: stop ? stop.stopReason : this.stopReason,
      stopDetails: stop ? stop.stopDetails : this.stopDetails,
      usage: this.usageRecord(),
      responseId: this.responseId,
      // Only a response that reached `message_stop` gets a history id. A
      // salvaged or truncated stream keeps `responseId` for diagnostics only.
      ...(this.completed && this.responseId !== undefined
        ? { providerMessageId: this.responseId }
        : {}),
    }
  }

  private storeText(index: number, text: string): void {
    this.blocks.push({ type: "text", text })
    this.storedTextIndexes.add(index)
  }
}

/**
 * Re-shape a canonical stream error into the tagged `Error` the retry
 * classifier reads (`streamErrorType`, `retryable`), with the attempt
 * progress attached for terminal-less recovery.
 */
function taggedStreamError(ev: StreamErrorEvent, progress: AttemptProgress): Error {
  // The verbatim upstream type beats the lossy category map.
  const streamErrorType =
    ev.upstreamType ?? STREAM_ERROR_TYPE_BY_CATEGORY[ev.category ?? "unknown"] ?? "unknown_error"
  const err = (
    ev.cause instanceof Error
      ? ev.cause
      : new Error(`canonical stream error: ${ev.category ?? "unknown"}`)
  ) as Error & { streamErrorType?: string; retryable?: boolean }
  if (err.streamErrorType === undefined) err.streamErrorType = streamErrorType
  // The provider's explicit verdict wins over a category that maps to a
  // retryable tag (for example a billing error).
  if (ev.retryable === false) err.retryable = false
  return attachAttemptProgress(err, { ...progress })
}

/**
 * Recover a stream that closed without a terminal event (Responses-style
 * SSE that ends before `response.completed`). Returns a response to use, or
 * `undefined` when the error must propagate to the retry layer.
 *
 * 1. Complete tool calls landed: return them as `tool_use`. The agent runs
 *    them once and does not replay the request.
 * 2. Text landed: return it as `end_turn`. The agent continues locally.
 * 3. Reasoning only, or nothing: throw, so the retry layer can take its one
 *    short pre-effect retry.
 */
function salvageTerminalLess(
  ev: StreamErrorEvent,
  b: ResponseBuilder,
): StreamedResponse | undefined {
  const type = ev.upstreamType ?? (ev.category === "api" ? "api_error" : undefined)
  if (type !== "stream_closed_without_terminal") return undefined
  b.discardOpenToolUse()
  if (b.progress.completedToolCalls > 0) {
    b.close()
    return b.build({
      stopReason: "tool_use",
      stopDetails: {
        type: "stream_closed_without_terminal",
        message:
          "Provider closed the stream without a terminal event after complete tool call(s). Salvaged closed tools and continuing from local state",
      },
    })
  }
  if (b.progress.sawText || b.text.trim().length > 0) {
    b.close()
    return b.build({
      stopReason: "end_turn",
      stopDetails: {
        type: "stream_closed_without_terminal",
        message:
          "Provider closed the stream without a terminal event after partial output. Preserved text and discarding incomplete tool calls",
      },
    })
  }
  return undefined
}

/**
 * Consume a canonical event stream. Yield visible text deltas (text and
 * refusal), fire the hooks in stream order, and return the assembled
 * {@link StreamedResponse}.
 *
 * @yields visible text deltas as they arrive.
 */
export async function* assembleStreamedResponse(
  events: AsyncIterable<CanonicalEvent>,
  hooks: StreamAssemblerHooks = {},
): AsyncGenerator<string, StreamedResponse, undefined> {
  const b = new ResponseBuilder()
  const telemetry = getStreamDeltaAccumulator()
  const countOutput = (chars: number) => {
    telemetry.add(chars)
    telemetry.maybeFlush(hooks.pluginEvents)
  }

  // Every exit path must drop the telemetry accumulator, or the next send
  // reuses stale pending tokens. Flush first so subscribers get the last window.
  try {
    for await (const ev of events) {
      b.note(ev.type)
      switch (ev.type) {
        case "message_start":
          b.start(ev)
          break
        case "text_start":
          b.openText(ev.index)
          await hooks.onBlockEdge?.({ block: "text", edge: "start" })
          break
        case "text_delta":
          b.appendText(ev.text)
          countOutput(ev.text.length)
          yield ev.text
          break
        case "text_stop":
          b.closeText(ev)
          await hooks.onBlockEdge?.({ block: "text", edge: "stop" })
          break
        case "thinking_start":
          b.openThinking()
          await hooks.onBlockEdge?.({ block: "thinking", edge: "start" })
          break
        case "thinking_delta":
          b.appendThinking(ev.text)
          countOutput(ev.text.length)
          await hooks.onThinkingDelta?.(ev.text)
          break
        case "thinking_signature":
          b.setSignature(ev.signature)
          break
        case "thinking_stop":
          b.closeThinking()
          await hooks.onBlockEdge?.({ block: "thinking", edge: "stop" })
          break
        case "tool_use_start":
          b.openToolUse(ev.id, ev.name)
          break
        case "tool_use_input_delta":
          b.appendToolInput(ev.partialJson)
          break
        case "tool_use_stop":
          b.closeToolUse()
          break
        case "refusal_delta":
          b.appendRefusal(ev.text)
          countOutput(ev.text.length)
          yield ev.text
          break
        case "message_delta":
          b.finish(ev)
          break
        case "message_stop":
          b.completed = true
          break
        case "ping":
          break
        case "stream_error": {
          const salvaged = salvageTerminalLess(ev, b)
          if (salvaged) return salvaged
          throw taggedStreamError(ev, b.progress)
        }
        default:
          throw new Error(`unhandled canonical event: ${JSON.stringify(ev satisfies never)}`)
      }
    }
  } finally {
    telemetry.flush(hooks.pluginEvents)
    emitOutputEnd("stream_end", hooks.pluginEvents)
    resetStreamDeltaAccumulator()
  }

  // A block left open means the stream stopped mid-block (for example
  // `max_tokens`). Store it so a truncated tool call still reaches the loop.
  b.close({ countCompletedTool: b.openKind === "tool_use" })
  return b.build()
}

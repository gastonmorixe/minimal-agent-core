/**
 * Bridge between the legacy `src/client.ts` `SendOptions` / `StreamedResponse`
 * surface and the canonical `CanonicalRequest` / `CanonicalEvent` surface.
 *
 * Why this exists: `client.ts` carries ~1500 lines of carefully tuned
 * cross-cutting infrastructure (stream-idle watchdog, hard-timeout
 * watchdog, retry coordinator with overloaded/api categorization,
 * 401 store-first refresh, network activity observer, cache anomaly
 * detector, status-bus updates, rate-limit broadcaster). Rewriting all
 * of that against the canonical layer is high-risk; this bridge lets
 * the legacy transport keep running while exposing a canonical
 * surface to new callers (OpenAI adapter, future agent migrations).
 *
 * Two functions:
 *
 * - {@link canonicalToSendOptions}: translate a `CanonicalRequest` plus
 *   capability-aware hooks into the legacy `SendOptions` shape. Used
 *   when a canonical caller wants the legacy transport's reliability.
 *
 * - {@link sendOptionsToCanonical}: wrap a legacy `sendMessage` /
 *   `sendMessageFull` call site so it yields canonical events. Useful
 *   when migrating consumers piece by piece.
 *
 * Both are **stateless**. The mid-stream callback hooks
 * (`onThinkingDelta`, `onTextStop`, etc.) become canonical events
 * fired through a passed-in async generator.
 *
 * @module llm/adapter-legacy
 */

import type { AuthResult } from "../auth/auth.ts"

import type { CanonicalEvent, CanonicalUsage, StopDetails, StopReason } from "./canonical-events.ts"
import type {
  CanonicalBlock,
  CanonicalMessage,
  FileSource,
  ImageSource,
  ToolResultContentBlock,
} from "./canonical-messages.ts"
import type { CanonicalRequest, ThinkingConfig } from "./canonical-request.ts"
import type { CanonicalToolDefinition } from "./canonical-tools.ts"
import type { EffortLevel } from "./capabilities.ts"
import type {
  ContentBlock as LegacyContentBlock,
  DocumentBlock as LegacyDocumentBlock,
  ImageBlock as LegacyImageBlock,
  Message as LegacyMessage,
} from "./messages.ts"
import { getDefaultModelId } from "./model-registry.ts"
import type { ProviderAuth } from "./provider.ts"
import type {
  SendOptions as LegacySendOptions,
  StreamedResponse as LegacyStreamedResponse,
  SystemBlock,
} from "./transport/types.ts"

// ---------------------------------------------------------------------------
// legacy StreamedResponse → canonical events
// ---------------------------------------------------------------------------

/**
 * Translate a completed legacy `StreamedResponse` into the canonical
 * event sequence the agent loop would have seen on the wire. Useful
 * for tests + for piping a buffered legacy response through canonical
 * consumers.
 *
 * Does NOT emit incremental deltas (the legacy structured response is
 * already coalesced). Callers wanting streaming should use the wrap
 * helper in `runLegacyAsCanonical` below instead.
 */
export function streamedResponseToCanonicalEvents(
  resp: LegacyStreamedResponse,
  modelId: string,
): CanonicalEvent[] {
  const events: CanonicalEvent[] = []
  const messageId = "msg_legacy"
  const initialUsage: CanonicalUsage = { inputTokens: 0, outputTokens: 0 }
  events.push({
    type: "message_start",
    messageId,
    modelId,
    initialUsage,
  })
  let blockIndex = 0
  for (const block of resp.blocks) {
    switch (block.type) {
      case "text":
        events.push({ type: "text_start", index: blockIndex })
        if (block.text)
          events.push({
            type: "text_delta",
            index: blockIndex,
            text: block.text,
          })
        events.push({
          type: "text_stop",
          index: blockIndex,
          finalText: block.text,
        })
        blockIndex++
        break
      case "thinking":
        events.push({ type: "thinking_start", index: blockIndex })
        if (block.thinking) {
          events.push({
            type: "thinking_delta",
            index: blockIndex,
            text: block.thinking,
          })
        }
        if (block.signature) {
          events.push({
            type: "thinking_signature",
            index: blockIndex,
            signature: block.signature,
          })
        }
        events.push({ type: "thinking_stop", index: blockIndex })
        blockIndex++
        break
      case "tool_use":
        events.push({
          type: "tool_use_start",
          index: blockIndex,
          id: block.id,
          name: block.name,
        })
        // Surface the fully-assembled input as a single "delta" so consumers
        // that accumulate by JSON fragment still see it.
        const partial = JSON.stringify(block.input)
        events.push({
          type: "tool_use_input_delta",
          index: blockIndex,
          partialJson: partial,
        })
        events.push({
          type: "tool_use_stop",
          index: blockIndex,
          input: block.input,
        })
        blockIndex++
        break
      // tool_result blocks never appear in an assistant response;
      // they're user-message blocks. Skip if encountered.
      default:
        break
    }
  }
  events.push({
    type: "message_delta",
    stopReason: mapLegacyStopReason(resp.stopReason),
    stopDetails: null,
    usage: initialUsage,
  })
  events.push({ type: "message_stop" })
  return events
}

// ---------------------------------------------------------------------------
// canonical message ↔ legacy message
// ---------------------------------------------------------------------------

/**
 * canonical message -\> legacy `Message`.
 *
 * Exported so callers that operate in the canonical layer (e.g. the
 * preflight resolution pipeline) can translate the resolved request
 * back into legacy shape for the legacy transport.
 */
export function canonicalMessageToLegacy(msg: CanonicalMessage): LegacyMessage {
  // Mid-conversation `role:"system"` collapses to a single string;
  // the legacy client doesn't support the role yet, so we approximate
  // by prepending a marker prefix on a user message. Callers that
  // need true mid-conv system should use the canonical path directly.
  if (msg.role === "system") {
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: `<system-instruction>\n${msg.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n")}\n</system-instruction>`,
        },
      ],
    }
  }
  if (msg.role === "tool") {
    // canonical role:"tool" maps to legacy role:"user" with tool_result block(s).
    return {
      role: "user",
      content: msg.content.map(canonicalBlockToLegacy).filter(Boolean) as LegacyContentBlock[],
    }
  }
  return {
    role: msg.role,
    content: msg.content.map(canonicalBlockToLegacy).filter(Boolean) as LegacyContentBlock[],
  }
}

function canonicalBlockToLegacy(block: CanonicalBlock): LegacyContentBlock | null {
  switch (block.type) {
    case "text":
      return {
        type: "text",
        text: block.text,
        ...(block.cache && { cache_control: legacyCacheControl(block.cache) }),
      }
    case "thinking":
      return {
        type: "thinking",
        thinking: block.text,
        signature: block.signature ?? "",
        ...(block.cache && { cache_control: legacyCacheControl(block.cache) }),
      }
    case "redacted_thinking":
      return {
        type: "redacted_thinking",
        data: block.data,
        ...(block.cache && { cache_control: legacyCacheControl(block.cache) }),
      }
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
        ...(block.cache && { cache_control: legacyCacheControl(block.cache) }),
      }
    case "tool_result": {
      const inner = block.content
        .map(canonicalBlockToLegacy)
        .filter(Boolean) as LegacyContentBlock[]
      const content: string | LegacyContentBlock[] =
        inner.length === 1 && inner[0]?.type === "text" ? inner[0].text : inner
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        is_error: block.isError,
        content,
        ...(block.cache && { cache_control: legacyCacheControl(block.cache) }),
      }
    }
    case "image":
      return {
        type: "image",
        source: imageSourceToLegacy(block.source),
        ...(block.cache && { cache_control: legacyCacheControl(block.cache) }),
      }
    case "file":
      return {
        type: "document",
        source: fileSourceToLegacy(block.source),
        ...(block.cache && { cache_control: legacyCacheControl(block.cache) }),
      }
    case "audio":
      // Anthropic Messages has no audio input. `validate()` (modalityViolations)
      // rejects an audio block before it reaches the wire, so dropping here is
      // only a belt-and-suspenders no-op.
      return null
    default: {
      throw new Error(`unhandled canonical block: ${String(block satisfies never)}`)
    }
  }
}

function legacyCacheControl(hint: NonNullable<CanonicalBlock["cache"]>): {
  type: "ephemeral"
  ttl?: "5m" | "1h"
  scope?: "global"
} {
  const out: { type: "ephemeral"; ttl?: "5m" | "1h"; scope?: "global" } = {
    type: "ephemeral",
  }
  if (hint.ttl) out.ttl = hint.ttl
  if (hint.scope) out.scope = hint.scope
  return out
}

/**
 * canonical {@link ImageSource} -\> Anthropic wire image source. The canonical
 * `file_id` kind maps to wire `source.type:"file"` (not `"file_id"`).
 */
function imageSourceToLegacy(source: ImageSource): LegacyImageBlock["source"] {
  switch (source.kind) {
    case "base64":
      return {
        type: "base64",
        media_type: source.mediaType,
        data: source.data,
      }
    case "url":
      return { type: "url", url: source.url }
    case "file_id":
      return { type: "file", file_id: source.fileId }
    default: {
      throw new Error(`unhandled media source: ${JSON.stringify(source satisfies never)}`)
    }
  }
}

/** canonical {@link FileSource} -\> Anthropic wire document source. */
function fileSourceToLegacy(source: FileSource): LegacyDocumentBlock["source"] {
  switch (source.kind) {
    case "base64":
      return {
        type: "base64",
        media_type: source.mediaType,
        data: source.data,
      }
    case "url":
      return { type: "url", url: source.url }
    case "file_id":
      return { type: "file", file_id: source.fileId }
    default: {
      throw new Error(`unhandled media source: ${JSON.stringify(source satisfies never)}`)
    }
  }
}

function mapLegacyStopReason(reason: string | null): StopReason | null {
  switch (reason) {
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
    default:
      return "error"
  }
}

// ---------------------------------------------------------------------------
// runLegacyAsCanonical — live streaming bridge
// ---------------------------------------------------------------------------

/**
 * Run a legacy `sendMessage` (or `sendMessageOnce`) call site and
 * yield canonical events live, as the underlying stream progresses.
 *
 * The supplied `legacyRunner` is the legacy iterator factory; we wrap
 * it with text-block tracking + a final `MessageDeltaEvent`.
 *
 * **Limitation**: the legacy client doesn't separately surface
 * thinking-block start/stop events on its iterator — only via the
 * callback hooks (`onThinkingDelta`, `onThinkingStop`). To get faithful
 * thinking events here you need to wire those into the
 * `onThinkingDelta` / `onTextStop` / etc. callbacks on the underlying
 * SendOptions and have them push into a shared queue we drain.
 *
 * For the OpenAI adapter we use this bridge only as a fallback — its
 * primary path is its own native SSE translator (see
 * `providers/openai/`).
 *
 * @yields Canonical events reconstructed from the legacy stream + callback queue.
 */
export async function* runLegacyAsCanonical(opts: {
  legacyRun: () => AsyncGenerator<string, LegacyStreamedResponse, undefined>
  modelId: string
  /** Stream events captured by the legacy callbacks. Pre-populated by the caller. */
  eventQueue?: AsyncIterable<CanonicalEvent>
}): AsyncIterable<CanonicalEvent> {
  // Emit a synthetic message_start.
  yield {
    type: "message_start",
    messageId: "msg_legacy",
    modelId: opts.modelId,
    initialUsage: { inputTokens: 0, outputTokens: 0 },
  }
  // If the caller pre-wired callbacks into a queue, drain it concurrently.
  if (opts.eventQueue) {
    for await (const ev of opts.eventQueue) yield ev
  } else {
    // Otherwise emit text deltas as one synthetic text block.
    let textIndex: number | null = null
    const gen = opts.legacyRun()
    while (true) {
      const next = await gen.next()
      if (next.done) {
        const resp = next.value
        if (textIndex !== null) {
          yield { type: "text_stop", index: textIndex }
        }
        // Surface tool_use blocks from the structured response.
        let blockIdx = (textIndex ?? -1) + 1
        for (const block of resp.blocks) {
          if (block.type === "tool_use") {
            yield {
              type: "tool_use_start",
              index: blockIdx,
              id: block.id,
              name: block.name,
            }
            yield {
              type: "tool_use_input_delta",
              index: blockIdx,
              partialJson: JSON.stringify(block.input),
            }
            yield {
              type: "tool_use_stop",
              index: blockIdx,
              input: block.input,
            }
            blockIdx++
          }
        }
        yield {
          type: "message_delta",
          stopReason: mapLegacyStopReason(resp.stopReason),
          stopDetails: null,
          usage: { inputTokens: 0, outputTokens: 0 },
        }
        break
      }
      const chunk = next.value
      if (chunk && textIndex === null) {
        textIndex = 0
        yield { type: "text_start", index: textIndex }
      }
      if (chunk && textIndex !== null) {
        yield { type: "text_delta", index: textIndex, text: chunk }
      }
    }
  }
  yield { type: "message_stop" }
}

// ===========================================================================
// INVERSE DIRECTION: legacy SendOptions -> canonical, canonical events ->
// legacy stream. Used by the provider-neutral transport (canonical-send.ts)
// that sits behind `Agent.sendFn` so non-Anthropic models actually dispatch.
// ===========================================================================

type LegacyCacheControl = {
  type: "ephemeral"
  ttl?: "5m" | "1h"
  scope?: "global"
}

/** legacy `cache_control` -\> canonical `cache` hint. */
function legacyCacheToCanonical(
  cc?: LegacyCacheControl,
): NonNullable<CanonicalBlock["cache"]> | undefined {
  if (!cc) return undefined
  const out: NonNullable<CanonicalBlock["cache"]> = { kind: "ephemeral" }
  if (cc.ttl) out.ttl = cc.ttl
  if (cc.scope) out.scope = cc.scope
  return out
}

/** legacy assistant/user `ContentBlock` -\> canonical block (null = dropped). */
function legacyBlockToCanonical(block: LegacyContentBlock): CanonicalBlock | null {
  switch (block.type) {
    case "text": {
      const out: CanonicalBlock = { type: "text", text: block.text }
      const cache = legacyCacheToCanonical(block.cache_control)
      if (cache) out.cache = cache
      return out
    }
    case "thinking": {
      const out: CanonicalBlock = { type: "thinking", text: block.thinking }
      if (block.signature) out.signature = block.signature
      const cache = legacyCacheToCanonical(block.cache_control)
      if (cache) out.cache = cache
      return out
    }
    case "redacted_thinking": {
      const out: CanonicalBlock = {
        type: "redacted_thinking",
        data: block.data,
      }
      const cache = legacyCacheToCanonical(block.cache_control)
      if (cache) out.cache = cache
      return out
    }
    case "tool_use": {
      const out: CanonicalBlock = {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      }
      const cache = legacyCacheToCanonical(block.cache_control)
      if (cache) out.cache = cache
      return out
    }
    case "tool_result": {
      // Legacy tool_result content is `string | ContentBlock[]`. Canonical
      // wants `ToolResultContentBlock[]` (text | image). Coerce: a bare string
      // becomes one text block; an array keeps its text AND image blocks (a
      // media-aware tool like `Read` emits an image block inside a tool_result
      // for a vision model : dropping it here would silently strip the
      // screenshot on the canonical transport). Any other inner block type is
      // dropped (none are valid tool_result content on the wire).
      const content: ToolResultContentBlock[] =
        typeof block.content === "string"
          ? [{ type: "text", text: block.content }]
          : block.content.flatMap((b): ToolResultContentBlock[] => {
              if (b.type === "text") return [{ type: "text", text: b.text }]
              if (b.type === "image")
                return [
                  {
                    type: "image",
                    source: legacyImageSourceToCanonical(b.source),
                  },
                ]
              return []
            })
      const out: CanonicalBlock = {
        type: "tool_result",
        toolUseId: block.tool_use_id,
        content,
      }
      if (block.is_error !== undefined) out.isError = block.is_error
      const cache = legacyCacheToCanonical(block.cache_control)
      if (cache) out.cache = cache
      return out
    }
    case "image": {
      const out: CanonicalBlock = {
        type: "image",
        source: legacyImageSourceToCanonical(block.source),
      }
      const cache = legacyCacheToCanonical(block.cache_control)
      if (cache) out.cache = cache
      return out
    }
    case "document": {
      // A `text` document source carries inline plain text : the faithful
      // canonical shape is a text block, not a file reference.
      if (block.source.type === "text") {
        const out: CanonicalBlock = { type: "text", text: block.source.data }
        const cache = legacyCacheToCanonical(block.cache_control)
        if (cache) out.cache = cache
        return out
      }
      const out: CanonicalBlock = {
        type: "file",
        source: legacyDocSourceToCanonical(block.source),
      }
      const cache = legacyCacheToCanonical(block.cache_control)
      if (cache) out.cache = cache
      return out
    }
    default: {
      throw new Error(`unhandled legacy block: ${JSON.stringify(block satisfies never)}`)
    }
  }
}

/** Anthropic wire image source -\> canonical {@link ImageSource}. */
function legacyImageSourceToCanonical(source: LegacyImageBlock["source"]): ImageSource {
  switch (source.type) {
    case "base64":
      return {
        kind: "base64",
        mediaType: source.media_type,
        data: source.data,
      }
    case "url":
      return { kind: "url", url: source.url }
    case "file":
      return { kind: "file_id", fileId: source.file_id }
    default: {
      throw new Error(`unhandled media source: ${JSON.stringify(source satisfies never)}`)
    }
  }
}

/** Anthropic wire document source (sans inline `text`) -\> canonical {@link FileSource}. */
function legacyDocSourceToCanonical(
  source: Exclude<LegacyDocumentBlock["source"], { type: "text" }>,
): FileSource {
  switch (source.type) {
    case "base64":
      return {
        kind: "base64",
        mediaType: source.media_type,
        data: source.data,
      }
    case "url":
      return { kind: "url", url: source.url }
    case "file":
      return { kind: "file_id", fileId: source.file_id }
    default: {
      throw new Error(`unhandled media source: ${JSON.stringify(source satisfies never)}`)
    }
  }
}

/**
 * legacy `Message` -\> canonical message.
 *
 * Exported so other layers (preflight pipeline, etc.) can convert
 * without re-implementing the per-block translation.
 */
export function legacyMessageToCanonical(msg: LegacyMessage): CanonicalMessage {
  const blocks =
    typeof msg.content === "string"
      ? [{ type: "text" as const, text: msg.content }]
      : (msg.content.map(legacyBlockToCanonical).filter(Boolean) as CanonicalBlock[])
  return { role: msg.role, content: blocks }
}

/** legacy `SystemBlock` -\> canonical text block (preserving cache hints). */
function systemBlockToCanonical(sb: SystemBlock): CanonicalBlock {
  const out: CanonicalBlock = { type: "text", text: sb.text }
  const cache = legacyCacheToCanonical(sb.cache_control)
  if (cache) out.cache = cache
  return out
}

/** legacy thinking opt -\> canonical `ThinkingConfig`. */
function legacyThinkingToCanonical(
  thinking: LegacySendOptions["thinking"],
): ThinkingConfig | undefined {
  if (thinking === undefined) return undefined
  if (thinking === false) return { mode: "off" }
  // `{type:"adaptive", display?}`. Map display: legacy "omitted" -> canonical
  // "omitted"; "summarized" -> canonical "summary" (round-trips back to wire
  // "summarized" via the Anthropic request-body mapper).
  if (thinking.display === undefined) return { mode: "adaptive" }
  return {
    mode: "adaptive",
    display: thinking.display === "omitted" ? "omitted" : "summary",
  }
}

/**
 * Map the legacy `AuthResult` to the provider-neutral `ProviderAuth`. The
 * OAuth refresh callback is preserved (re-shaped to the `{token}` return
 * the canonical transport expects); the multi-process store-first race
 * fix lives in the transport middleware, not here.
 */
export function legacyAuthToProviderAuth(auth: AuthResult): ProviderAuth {
  if (auth.type === "provider") return auth.auth
  if (auth.type === "oauth") {
    if (auth.refresh) {
      const refresh = auth.refresh
      return {
        kind: "oauth",
        token: auth.token,
        refresh: async () => {
          const refreshed = await refresh()
          if (refreshed.type !== "oauth" && refreshed.type !== "api-key") {
            throw new Error("provider-native auth refresh cannot produce a bearer token")
          }
          return { token: refreshed.token }
        },
      }
    }
    return { kind: "oauth", token: auth.token }
  }
  return { kind: "api-key", key: auth.token }
}

/**
 * Translate a legacy `SendOptions` into a `CanonicalRequest`. The inverse
 * of {@link canonicalToSendOptions}. Transport-level fields (`auth`,
 * `networkClient`, lifecycle callbacks) are NOT part of the request : the
 * caller threads them into the `RunContext` / event bridge separately.
 *
 * `modelId` falls back to the current foundation model when unset, matching
 * the legacy client's `DEFAULT_MODEL` behavior; in practice `Agent.run`
 * always sets `model`.
 */
export function sendOptionsToCanonical(opts: LegacySendOptions): CanonicalRequest {
  const req: CanonicalRequest = {
    modelId: opts.model ?? getDefaultModelId(),
    messages: opts.messages.map(legacyMessageToCanonical),
    stream: opts.stream ?? true,
  }
  if (opts.selectedProviderId) {
    req.providerId = opts.selectedProviderId
  }
  if (opts.system) req.system = opts.system.map(systemBlockToCanonical)
  if (opts.tools && opts.tools.length > 0) {
    req.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema as CanonicalToolDefinition["inputSchema"],
    }))
  }
  const generation: NonNullable<CanonicalRequest["generation"]> = {}
  if (opts.maxTokens !== undefined) generation.maxOutputTokens = opts.maxTokens
  if (opts.temperature !== undefined) generation.temperature = opts.temperature
  if (Object.keys(generation).length > 0) req.generation = generation
  const thinking = legacyThinkingToCanonical(opts.thinking)
  if (thinking) req.thinking = thinking
  if (opts.outputConfig?.effort) req.effort = opts.outputConfig.effort as EffortLevel
  if (opts.outputConfig?.format?.type === "json_schema" && opts.outputConfig.format.schema) {
    req.outputFormat = {
      type: "json_schema",
      schema: opts.outputConfig.format.schema as object,
    }
  }
  if (opts.speed) req.speed = opts.speed
  if (opts.serviceTier) req.serviceTier = opts.serviceTier
  if (opts.signal) req.signal = opts.signal
  if (opts.streamIdleTimeoutMs !== undefined) req.streamIdleTimeoutMs = opts.streamIdleTimeoutMs
  if (opts.attemptHardTimeoutMs !== undefined) req.attemptHardTimeoutMs = opts.attemptHardTimeoutMs
  return req
}

// Stream bridge lives in its own module to keep this file under the
// 810-line cap (see .oxlintrc.json `max-lines`). Re-export so existing
// import paths (`./adapter-legacy`) keep working.
export type { LegacyStreamCallbacks } from "./adapter-legacy-stream.ts"
export { canonicalEventsToLegacyStream } from "./adapter-legacy-stream.ts"

// ---------------------------------------------------------------------------
// Re-exports for test ergonomics
// ---------------------------------------------------------------------------

export type { StopDetails, StopReason }

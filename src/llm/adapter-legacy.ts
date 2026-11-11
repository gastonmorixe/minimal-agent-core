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
 * (`onThinkingDelta`, `onBlockEdge`) become canonical events
 * fired through a passed-in async generator.
 *
 * @module llm/adapter-legacy
 */

import type { AuthResult } from "../auth/auth.ts"

import type { StopDetails, StopReason } from "./canonical-events.ts"
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
import type { SendOptions as LegacySendOptions, SystemBlock } from "./transport/types.ts"

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

// ---------------------------------------------------------------------------
// runLegacyAsCanonical — live streaming bridge
// ---------------------------------------------------------------------------

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

/** Longest `outputFormat.name` (OpenAI `json_schema.name` rule). */
const OUTPUT_FORMAT_NAME_MAX = 64

/**
 * Stable `outputFormat.name` for a JSON Schema: its `title` when that is a
 * string, else `"output"`. Every char outside `[a-zA-Z0-9_-]` becomes `_`,
 * and the result is cut to 64 chars (the OpenAI `json_schema.name` rule).
 * An empty result falls back to `"output"`. Provider builders decide
 * whether to send it (Anthropic does not).
 */
export function outputFormatName(schema: object): string {
  const title = (schema as { title?: unknown }).title
  const raw = typeof title === "string" ? title : ""
  const name = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, OUTPUT_FORMAT_NAME_MAX)
  return name.length > 0 ? name : "output"
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
  // A legacy title request (for example host `llm.complete`) gets the
  // canonical title marker. Providers classify a title only by it.
  if (opts.requestType === "title") req.purpose = "title"
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
    const schema = opts.outputConfig.format.schema as object
    // `strict` rides the send format (`sdk/output-config.ts`). The transport
    // type does not declare it, so read it structurally.
    const strict = (opts.outputConfig.format as { strict?: unknown }).strict === true
    req.outputFormat = {
      type: "json_schema",
      schema,
      name: outputFormatName(schema),
      ...(strict ? { strict: true } : {}),
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

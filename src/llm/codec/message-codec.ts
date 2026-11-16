/**
 * Message codec: the stored conversation shape and the canonical shape.
 *
 * The agent keeps and persists messages as {@link Message} (`llm/messages.ts`:
 * snake_case blocks, the session JSONL format). Provider adapters speak the
 * canonical message shape (`canonical-messages.ts`: camelCase). This module
 * maps between the two, one block at a time, in both directions.
 *
 * Pure functions. No I/O, no provider knowledge.
 *
 * @module llm/codec/message-codec
 */

import type {
  CanonicalBlock,
  CanonicalMessage,
  FileSource,
  ImageSource,
  ToolResultContentBlock,
} from "../canonical-messages.ts"
import type {
  BlockCacheControl,
  ContentBlock,
  DocumentBlock,
  ImageBlock,
  Message,
} from "../messages.ts"

type CacheHint = NonNullable<CanonicalBlock["cache"]>

/** Stored media source shared by images and non-text documents. */
type StoredMediaSource = ImageBlock["source"]

// ---------------------------------------------------------------------------
// Shared field mappers
// ---------------------------------------------------------------------------

function cacheControlFromHint(hint: CacheHint): BlockCacheControl {
  const out: BlockCacheControl = { type: "ephemeral" }
  if (hint.ttl) out.ttl = hint.ttl
  if (hint.scope) out.scope = hint.scope
  return out
}

function cacheHintFromControl(cc: BlockCacheControl | undefined): CacheHint | undefined {
  if (!cc) return undefined
  const out: CacheHint = { kind: "ephemeral" }
  if (cc.ttl) out.ttl = cc.ttl
  if (cc.scope) out.scope = cc.scope
  return out
}

/** Spread helper: `{ cache_control }` when the canonical block has a hint. */
function withCacheControl(block: CanonicalBlock): { cache_control?: BlockCacheControl } {
  return block.cache ? { cache_control: cacheControlFromHint(block.cache) } : {}
}

/** Copy the stored `cache_control` onto a canonical block as a cache hint. */
function setCacheHint<T extends CanonicalBlock>(out: T, cc: BlockCacheControl | undefined): T {
  const cache = cacheHintFromControl(cc)
  if (cache) out.cache = cache
  return out
}

/**
 * Canonical media source to the stored source. The canonical `file_id` kind
 * is `source.type: "file"` on the wire (not `"file_id"`).
 */
function mediaSourceFromCanonical(source: ImageSource | FileSource): StoredMediaSource {
  switch (source.kind) {
    case "base64":
      return { type: "base64", media_type: source.mediaType, data: source.data }
    case "url":
      return { type: "url", url: source.url }
    case "file_id":
      return { type: "file", file_id: source.fileId }
    default:
      throw new Error(`unhandled media source: ${JSON.stringify(source satisfies never)}`)
  }
}

/** Stored media source to the canonical source. */
function mediaSourceToCanonical(source: StoredMediaSource): ImageSource & FileSource {
  switch (source.type) {
    case "base64":
      return { kind: "base64", mediaType: source.media_type, data: source.data }
    case "url":
      return { kind: "url", url: source.url }
    case "file":
      return { kind: "file_id", fileId: source.file_id }
    default:
      throw new Error(`unhandled media source: ${JSON.stringify(source satisfies never)}`)
  }
}

// ---------------------------------------------------------------------------
// Canonical -> stored
// ---------------------------------------------------------------------------

function blockFromCanonical(block: CanonicalBlock): ContentBlock | null {
  switch (block.type) {
    case "text":
      return {
        type: "text",
        text: block.text,
        ...withCacheControl(block),
        ...(block.sideband && { sideband: { kind: block.sideband.kind } }),
      }
    case "thinking":
      return {
        type: "thinking",
        thinking: block.text,
        signature: block.signature ?? "",
        ...withCacheControl(block),
      }
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data, ...withCacheControl(block) }
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
        ...withCacheControl(block),
      }
    case "tool_result": {
      const inner = blocksFromCanonical(block.content)
      // One text block collapses to the plain string form.
      const content: string | ContentBlock[] =
        inner.length === 1 && inner[0]?.type === "text" ? inner[0].text : inner
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        is_error: block.isError,
        content,
        ...withCacheControl(block),
        ...(block.sideband && { sideband: { kind: block.sideband.kind } }),
      }
    }
    case "image":
      return {
        type: "image",
        source: mediaSourceFromCanonical(block.source),
        ...withCacheControl(block),
      }
    case "file":
      return {
        type: "document",
        source: mediaSourceFromCanonical(block.source),
        ...withCacheControl(block),
      }
    case "audio":
      // No stored audio block. `validate()` (modalityViolations) rejects audio
      // before the wire, so this drop is only a guard.
      return null
    default:
      throw new Error(`unhandled canonical block: ${String(block satisfies never)}`)
  }
}

function blocksFromCanonical(blocks: readonly CanonicalBlock[]): ContentBlock[] {
  return blocks.map(blockFromCanonical).filter((b): b is ContentBlock => b !== null)
}

/**
 * Canonical message to the stored {@link Message}.
 *
 * 1. `role: "tool"` becomes `role: "user"` with the tool_result blocks.
 * 2. A mid-conversation `role: "system"` becomes a user message wrapped in
 *    `<system-instruction>`. The stored shape has no mid-conversation system
 *    role. A caller that needs one must stay on the canonical path.
 */
export function messageFromCanonical(msg: CanonicalMessage): Message {
  if (msg.role === "system") {
    const text = msg.content
      .filter((b): b is Extract<CanonicalBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
    return {
      role: "user",
      content: [{ type: "text", text: `<system-instruction>\n${text}\n</system-instruction>` }],
    }
  }
  const out: Message = {
    role: msg.role === "tool" ? "user" : msg.role,
    content: blocksFromCanonical(msg.content),
  }
  if (msg.role === "assistant" && msg.providerMessageId) {
    out.providerMessageId = msg.providerMessageId
  }
  return out
}

// ---------------------------------------------------------------------------
// Stored -> canonical
// ---------------------------------------------------------------------------

/**
 * Stored tool_result content to canonical content. A bare string becomes one
 * text block. Text and image blocks are kept (a media-aware tool like `Read`
 * returns a screenshot inside a tool_result). Other block types are not valid
 * tool_result content and are dropped.
 */
function toolResultContentToCanonical(content: string | ContentBlock[]): ToolResultContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  return content.flatMap((b): ToolResultContentBlock[] => {
    if (b.type === "text") return [{ type: "text", text: b.text }]
    if (b.type === "image") return [{ type: "image", source: mediaSourceToCanonical(b.source) }]
    return []
  })
}

function documentToCanonical(block: DocumentBlock): CanonicalBlock {
  // An inline `text` document is plain text, not a file reference.
  if (block.source.type === "text") {
    return setCacheHint({ type: "text", text: block.source.data }, block.cache_control)
  }
  return setCacheHint(
    { type: "file", source: mediaSourceToCanonical(block.source) },
    block.cache_control,
  )
}

/** Stored block to canonical block. */
function blockToCanonical(block: ContentBlock): CanonicalBlock {
  switch (block.type) {
    case "text": {
      const out: CanonicalBlock = { type: "text", text: block.text }
      if (block.sideband) out.sideband = { kind: block.sideband.kind }
      return setCacheHint(out, block.cache_control)
    }
    case "thinking": {
      const out: CanonicalBlock = { type: "thinking", text: block.thinking }
      if (block.signature) out.signature = block.signature
      return setCacheHint(out, block.cache_control)
    }
    case "redacted_thinking":
      return setCacheHint({ type: "redacted_thinking", data: block.data }, block.cache_control)
    case "tool_use":
      return setCacheHint(
        { type: "tool_use", id: block.id, name: block.name, input: block.input },
        block.cache_control,
      )
    case "tool_result": {
      const out: CanonicalBlock = {
        type: "tool_result",
        toolUseId: block.tool_use_id,
        content: toolResultContentToCanonical(block.content),
      }
      if (block.is_error !== undefined) out.isError = block.is_error
      if (block.sideband) out.sideband = { kind: block.sideband.kind }
      return setCacheHint(out, block.cache_control)
    }
    case "image":
      return setCacheHint(
        { type: "image", source: mediaSourceToCanonical(block.source) },
        block.cache_control,
      )
    case "document":
      return documentToCanonical(block)
    default:
      throw new Error(`unhandled stored block: ${JSON.stringify(block satisfies never)}`)
  }
}

/** Stored {@link Message} to canonical message. */
export function messageToCanonical(msg: Message): CanonicalMessage {
  const content: CanonicalBlock[] =
    typeof msg.content === "string"
      ? [{ type: "text", text: msg.content }]
      : msg.content.map(blockToCanonical)
  const out: CanonicalMessage = { role: msg.role, content }
  // Metadata for adapters (e.g. Anthropic `diagnostics.previous_message_id`).
  // Adapters build wire messages field by field, so it never reaches the wire.
  if (msg.role === "assistant" && msg.providerMessageId) {
    out.providerMessageId = msg.providerMessageId
  }
  return out
}

/** Canonical text block for a stored system block (keeps the cache hint). */
export function systemTextToCanonical(sb: {
  text: string
  cache_control?: BlockCacheControl
}): CanonicalBlock {
  return setCacheHint({ type: "text", text: sb.text }, sb.cache_control)
}

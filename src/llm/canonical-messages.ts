/**
 * Canonical message + content-block types consumed by the agent loop
 * and emitted by every {@link ProviderAdapter}.
 *
 * Why a canonical shape instead of re-using Anthropic's wire types:
 * Anthropic's `ContentBlock` (text / thinking / tool_use / tool_result)
 * is close to what we want, but it bakes in details that don't
 * survive a provider swap:
 *
 * - OpenAI Chat's tool result is `{role:"tool", content:string}` and
 *   the result is paired to the call via `tool_call_id`, not nested
 *   inside the assistant's `tool_use` block.
 * - OpenAI Responses keeps the call as a top-level `function_call` item
 *   and the result as a `function_call_output` item.
 * - Image / audio / file inputs have radically different wire shapes.
 * - `signature` on Anthropic thinking blocks is a verification token
 *   the server requires verbatim on the next request : it has no
 *   equivalent on OpenAI.
 *
 * The canonical types abstract these into a small, opinionated set:
 *
 * - `text`: plain assistant prose.
 * - `thinking`: visible reasoning (may carry an opaque `signature` the
 *   adapter preserves verbatim on its way back to the same provider).
 * - `tool_use`: assistant wants to call tool `name(input)`.
 * - `tool_result`: paired follow-up with `toolUseId`. Always lives in
 *   a `role:"user"` message in canonical form, no matter how the
 *   provider wraps it on the wire.
 * - `image` / `audio` / `file`: typed sources with provider-neutral
 *   media descriptors.
 *
 * The `cache?` field on every block is a provider-neutral hint. Anthropic
 * adapter translates it to `cache_control`; OpenAI adapters drop it
 * because their cache is automatic.
 *
 * @module llm/canonical-messages
 */

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Conversation roles. Note `system` here means a mid-conversation
 * system message that lives **inside** `messages[]` (Anthropic
 * `mid-conversation-system-2026-04-07`, OpenAI Chat anywhere). The
 * top-level "system prompt" lives on `CanonicalRequest.system` and is
 * not a message.
 */
export type CanonicalRole = "user" | "assistant" | "system" | "tool"

// ---------------------------------------------------------------------------
// Cache hints
// ---------------------------------------------------------------------------

/**
 * Provider-neutral hint that a caching breakpoint should land on the
 * containing block / message. Adapter is free to drop or downgrade.
 *
 * - `kind:"ephemeral"`: matches Anthropic's `cache_control.type:
 *   "ephemeral"`. Default behavior on every provider that supports
 *   explicit cache control.
 * - `ttl`: requested TTL. Anthropic accepts `"5m"` and `"1h"` (the
 *   latter behind `extended-cache-ttl-2025-04-11`). Drop or coerce on
 *   providers that auto-cache.
 * - `scope:"global"`: share the cache org-wide instead of per-session
 *   (Anthropic `prompt-caching-scope-2026-01-05`).
 */
export interface CanonicalCacheHint {
  kind: "ephemeral"
  ttl?: "5m" | "1h"
  scope?: "global"
}

// ---------------------------------------------------------------------------
// Media sources
// ---------------------------------------------------------------------------

/**
 * Where to fetch image data from. `url` for hosted images,
 * `base64` for inline data with a mime type, `fileId` for a
 * provider-hosted file reference.
 */
export type ImageSource =
  | { kind: "url"; url: string; detail?: "low" | "high" | "auto" }
  | { kind: "base64"; mediaType: string; data: string; detail?: "low" | "high" | "auto" }
  | { kind: "file_id"; fileId: string; detail?: "low" | "high" | "auto" }

export type AudioSource =
  | { kind: "url"; url: string; format?: string }
  | { kind: "base64"; format: string; data: string }
  | { kind: "file_id"; fileId: string }

export type FileSource =
  | { kind: "url"; url: string; filename?: string; mediaType?: string }
  | { kind: "base64"; mediaType: string; data: string; filename?: string }
  | { kind: "file_id"; fileId: string }

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: "text"
  text: string
  cache?: CanonicalCacheHint
}

/**
 * Visible reasoning. `text` may be empty when the provider redacted it
 * (Anthropic `display:"omitted"`); the `signature` is opaque and must
 * be echoed back verbatim on the next request to the same provider for
 * cryptographic verification.
 */
export interface ThinkingBlock {
  type: "thinking"
  text: string
  signature?: string
  cache?: CanonicalCacheHint
}

/**
 * Encrypted ("redacted") reasoning block. The provider emits these instead of
 * a plain {@link ThinkingBlock} when its safety systems encrypt the model's
 * reasoning. `data` is opaque and MUST round-trip verbatim : dropping or
 * altering it makes the latest-assistant-turn re-send fail
 * ("`thinking`/`redacted_thinking` blocks ... cannot be modified").
 */
export interface RedactedThinkingBlock {
  type: "redacted_thinking"
  data: string
  cache?: CanonicalCacheHint
}

export interface ToolUseBlock {
  type: "tool_use"
  /** Pairs with `ToolResultBlock.toolUseId`. Adapter-stable id. */
  id: string
  /** Tool name as declared in `CanonicalToolDefinition.name`. */
  name: string
  /** Already-parsed input. Adapters JSON-encode for the wire as needed. */
  input: unknown
  cache?: CanonicalCacheHint
}

export interface ToolResultBlock {
  type: "tool_result"
  toolUseId: string
  isError?: boolean
  /**
   * Result body. Almost always one `text` block. `image` / `file`
   * blocks are accepted by providers that allow rich tool outputs
   * (Anthropic Messages, OpenAI Responses); OpenAI Chat coerces to
   * the text concatenation.
   */
  content: ToolResultContentBlock[]
  cache?: CanonicalCacheHint
}

export type ToolResultContentBlock = TextBlock | ImageBlock

export interface ImageBlock {
  type: "image"
  source: ImageSource
  cache?: CanonicalCacheHint
}

export interface AudioBlock {
  type: "audio"
  source: AudioSource
  cache?: CanonicalCacheHint
}

export interface FileBlock {
  type: "file"
  source: FileSource
  cache?: CanonicalCacheHint
}

/**
 * Union of every block type that can appear inside a message.
 *
 * In practice:
 * - `user` messages: text / image / audio / file / tool_result.
 * - `assistant` messages: text / thinking / tool_use.
 * - `system` (mid-conversation): text only on every observed provider.
 * - `tool`: typically a single `text` content (OpenAI Chat); canonical
 *   form prefers `role:"user"` + `tool_result` block instead, but we
 *   accept either on input and the adapter normalizes.
 */
export type CanonicalBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | AudioBlock
  | FileBlock

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * A single conversation turn in canonical form.
 *
 * `content` is always an array of blocks. Plain-string shorthand is a
 * wire detail : adapters string-encode on the way out when the
 * provider expects it (e.g. Anthropic quota probe uses
 * `content:"quota"`).
 *
 * `toolCallId` is set on `role:"tool"` messages (OpenAI shape). We
 * accept either form on input.
 */
export interface CanonicalMessage {
  role: CanonicalRole
  content: CanonicalBlock[]
  /** Set on `role:"tool"` only; matches the originating tool_use id. */
  toolCallId?: string
  /**
   * Provider hint to land a caching breakpoint at this message. Often
   * unused; per-block `cache?` is more common.
   */
  cache?: CanonicalCacheHint
}

// ---------------------------------------------------------------------------
// Constructors (lower-friction call sites)
// ---------------------------------------------------------------------------

/**
 * Build a canonical user message from plain text. Convenience for the
 * common case `{role:"user", content:[{type:"text", text}]}`.
 */
export function userText(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] }
}

/**
 * Build a canonical assistant message from plain text.
 */
export function assistantText(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] }
}

/**
 * Build a mid-conversation operator message. Lands as `role:"system"`
 * inside `messages[]` on providers that accept it (Anthropic
 * mid-conversation-system beta; OpenAI Chat/Responses always). On
 * other providers, `validate()` flags this as an
 * {@link UnsupportedCapabilityError}.
 */
export function systemMessage(text: string): CanonicalMessage {
  return { role: "system", content: [{ type: "text", text }] }
}

/**
 * Build a canonical tool_result follow-up. Wrapped in a `role:"user"`
 * message because that's the canonical pairing (Anthropic). OpenAI Chat
 * adapter unwraps to `role:"tool"`; OpenAI Responses adapter wraps as
 * a `function_call_output` item.
 */
export function toolResult(
  toolUseId: string,
  content: ToolResultContentBlock[] | string,
  opts?: { isError?: boolean; cache?: CanonicalCacheHint },
): CanonicalMessage {
  const blocks: ToolResultContentBlock[] =
    typeof content === "string" ? [{ type: "text", text: content }] : content
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId,
        content: blocks,
        isError: opts?.isError,
        cache: opts?.cache,
      },
    ],
  }
}

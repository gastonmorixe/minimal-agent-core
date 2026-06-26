/**
 * Conversation message + content-block types the agent loop speaks.
 *
 * These are the provider-neutral shapes the agent keeps in memory and
 * persists to the session JSONL. They are deliberately close to a
 * block-based chat wire format (a `role` plus an array of typed content
 * blocks), but they name no provider: every adapter translates them
 * to/from its own wire format at the edge.
 *
 * The block field names use snake_case (`tool_use_id`, `cache_control`)
 * because that is the on-disk persisted shape; renaming them would break
 * resume of existing sessions. The canonical request/event types in
 * `@minimal-agent/plugin-api/llm/*` are the camelCase transport vocabulary
 * the provider port consumes; the transport codec maps between the two.
 *
 * @module llm/messages
 */

// ---------------------------------------------------------------------------
// Content block types
// ---------------------------------------------------------------------------

/**
 * `cache_control` shape accepted on individual content blocks. A caching
 * breakpoint hint: the active provider lands a breakpoint on the marked
 * block (or drops the hint if it auto-caches). The rolling-tail breakpoint
 * the agent sets each turn uses `ttl:"1h"`.
 */
export type BlockCacheControl = {
  type: "ephemeral"
  ttl?: "5m" | "1h"
  scope?: "global"
}

/**
 * A plain text content block.
 *
 * Used in user messages (input prose) and assistant messages (response
 * text). The smallest unit of conversation content.
 *
 * @example
 * ```ts
 * { type: "text", text: "Hello, world!" }
 * ```
 */
export interface TextBlock {
  type: "text"
  text: string
  cache_control?: BlockCacheControl
}

/**
 * An assistant thinking block (visible reasoning).
 *
 * When the provider redacts reasoning, `thinking` is empty and only the
 * cryptographic `signature` is returned. Both fields must be preserved
 * verbatim in conversation history: the provider verifies the signature on
 * every subsequent request to the same model.
 *
 * @example
 * ```ts
 * { type: "thinking", thinking: "", signature: "EpUCClkIDBgC..." }
 * ```
 */
export interface ThinkingBlock {
  type: "thinking"
  /** Visible reasoning text. Empty when reasoning is redacted. */
  thinking: string
  /** Opaque signature verifying the reasoning happened. */
  signature: string
  cache_control?: BlockCacheControl
}

/**
 * An encrypted ("redacted") reasoning block. Some providers emit these
 * instead of a plain {@link ThinkingBlock} when their safety systems
 * encrypt the model's reasoning. The `data` payload is opaque: we never
 * introspect it, but we MUST round-trip it verbatim. The provider rejects
 * any request whose latest assistant turn dropped or altered a
 * `thinking`/`redacted_thinking` block, so the stream parser stores these
 * and the send path re-emits them unchanged.
 */
export interface RedactedThinkingBlock {
  type: "redacted_thinking"
  /** Opaque encrypted reasoning payload. Re-sent verbatim, never parsed. */
  data: string
  cache_control?: BlockCacheControl
}

/**
 * A tool invocation requested by the assistant.
 *
 * The model emits these when it wants to call a tool. The agent executes
 * the tool, then sends back a {@link ToolResultBlock} with the same
 * `tool_use_id` to keep the conversation paired up.
 *
 * @example
 * ```ts
 * { type: "tool_use", id: "tool_01ABC...", name: "Bash", input: { command: "ls -la" } }
 * ```
 */
export interface ToolUseBlock {
  type: "tool_use"
  /** Unique ID for this call. Pairs with the matching tool_result. */
  id: string
  /** Tool name (must match a tool definition's `name`). */
  name: string
  /** Parsed JSON input matching the tool's `input_schema`. */
  input: Record<string, unknown>
  /** Origin of the call (currently always `{type:"direct"}`). */
  caller?: { type: string }
  cache_control?: BlockCacheControl
}

/**
 * A tool execution result sent back from the user (agent) to the model.
 *
 * Must reference the original `tool_use` block via `tool_use_id`. The
 * `content` field is the tool's output as a string (or nested blocks for
 * rich output). Set `is_error` when the tool failed: the model uses this
 * to decide whether to retry, pick a different tool, or give up.
 *
 * @example
 * ```ts
 * { type: "tool_result", tool_use_id: "tool_01ABC...", content: "total 24\n..." }
 * ```
 */
export interface ToolResultBlock {
  type: "tool_result"
  /** The `id` from the `tool_use` block this result corresponds to. */
  tool_use_id: string
  /** Tool output. A plain string or nested content blocks. */
  content: string | ContentBlock[]
  /** True if the tool failed. */
  is_error?: boolean
  cache_control?: BlockCacheControl
}

/**
 * An image input block. One of three mutually-exclusive `source` shapes:
 *
 * - `base64`: inline bytes + `media_type` (e.g. `image/jpeg`).
 * - `url`: the provider fetches the image.
 * - `file`: a provider Files-API `file_id`.
 *
 * Common accepted formats: JPEG, PNG, GIF, WebP.
 */
export interface ImageBlock {
  type: "image"
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string }
    | { type: "file"; file_id: string }
  cache_control?: BlockCacheControl
}

/**
 * A document input block (PDF / plain-text support). Same `source`
 * trichotomy as {@link ImageBlock} plus an inline `text` source for plain
 * text. Optional `title` / `context` / `citations` mirror the provider's
 * document API.
 */
export interface DocumentBlock {
  type: "document"
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string }
    | { type: "file"; file_id: string }
    | { type: "text"; media_type: "text/plain"; data: string }
  title?: string
  context?: string
  citations?: { enabled: boolean }
  cache_control?: BlockCacheControl
}

/**
 * Union of all content block types the conversation can carry.
 *
 * Used as the element type of {@link Message.content} when content is an
 * array (block-based mode). Plain string content is also supported for
 * simple user messages but the provider normalizes it to a single text
 * block.
 */
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

/**
 * A single conversation turn.
 *
 * Plain `string` content is supported for simple user messages but new
 * code should use the array form for consistency with the block-based
 * shape.
 *
 * @example
 * ```ts
 * // Simple text message:
 * { role: "user", content: [{ type: "text", text: "hi" }] }
 *
 * // Assistant with thinking and tool call:
 * {
 *   role: "assistant",
 *   content: [
 *     { type: "thinking", thinking: "", signature: "..." },
 *     { type: "tool_use", id: "tool_01...", name: "Bash", input: {command: "ls"} }
 *   ]
 * }
 *
 * // Tool result follow-up:
 * {
 *   role: "user",
 *   content: [{ type: "tool_result", tool_use_id: "tool_01...", content: "..." }]
 * }
 * ```
 */
export interface Message {
  /**
   * Conversation role.
   *
   * - `"user"`, `"assistant"`: the bread-and-butter pair every model
   *   supports.
   * - `"system"`: a **mid-conversation** operator message that lives inside
   *   `messages[]` (distinct from the top-level system prompt prefix).
   *   Capability-gated: providers that don't support mid-conversation
   *   system messages reject it.
   */
  role: "user" | "assistant" | "system"
  content: string | ContentBlock[]
}

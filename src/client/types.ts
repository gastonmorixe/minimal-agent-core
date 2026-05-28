/**
 * Wire-format types used by the Anthropic Messages v2.1.118 traffic
 * the client emits: content blocks, messages, send options, the
 * streamed response shape, and the small per-model metadata helpers
 * (`normalizeModelForAPI`, `has1mContext`).
 *
 * Split out of `src/client.ts` to keep that file under the
 * `max-lines` lint budget. All public names are re-exported from
 * `client.ts` for back-compat with existing consumers.
 *
 * @module client/types
 */

import type { AuthResult } from "../auth.ts"
import type { RequestType, SystemBlock } from "../headers.ts"
import type { NetworkClient } from "../network/index.ts"

type MaybePromise<T> = T | Promise<T>

// ---------------------------------------------------------------------------
// Content block types (matching v2.1.118 traffic)
// ---------------------------------------------------------------------------

/**
 * A plain text content block.
 *
 * Used in user messages (input prose) and assistant messages (response text).
 * The smallest unit of conversation content.
 *
 * @example
 * ```ts
 * { type: "text", text: "Hello, world!" }
 * ```
 */
/**
 * `cache_control` shape accepted on individual content blocks. Live 2.1.118
 * traffic puts this on the LAST block of the LAST message every conversation
 * turn (rolling-tail breakpoint) with `ttl:"1h"` and no `scope`.
 */
export type BlockCacheControl = {
  type: "ephemeral"
  ttl?: "5m" | "1h"
  scope?: "global"
}

export interface TextBlock {
  type: "text"
  text: string
  cache_control?: BlockCacheControl
}

/**
 * An assistant thinking block. Required by `redact-thinking-2026-02-12` beta.
 *
 * In v2.1.91 the `thinking` field is empty (the model's reasoning is
 * server-side only) but the `signature` field contains a cryptographic
 * proof that the model emitted thinking. Both fields must be preserved
 * verbatim in conversation history for subsequent turns : the server
 * verifies the signature on every request.
 *
 * @example
 * ```ts
 * { type: "thinking", thinking: "", signature: "EpUCClkIDBgC..." }
 * ```
 */
export interface ThinkingBlock {
  type: "thinking"
  /** Visible reasoning text. Empty when redact-thinking is active. */
  thinking: string
  /** Cryptographic signature verifying the thinking happened. */
  signature: string
  cache_control?: BlockCacheControl
}

/**
 * A tool invocation requested by the assistant.
 *
 * The model emits these when it wants to call a tool. The agent should
 * execute the tool, then send back a {@link ToolResultBlock} with the same
 * `tool_use_id` to keep the conversation paired up.
 *
 * **`caller` field** (new in v2.1.91): indicates whether the tool call
 * originated from the model directly or from a sub-agent / nested context.
 * Currently always `{type:"direct"}` in observed traffic.
 *
 * @example
 * ```ts
 * {
 *   type: "tool_use",
 *   id: "toolu_01ABC...",
 *   name: "Bash",
 *   input: { command: "ls -la" },
 *   caller: { type: "direct" }
 * }
 * ```
 */
export interface ToolUseBlock {
  type: "tool_use"
  /** Unique ID for this call. Used to pair with the matching tool_result. */
  id: string
  /** Tool name (must match a {@link ToolDefinition.name}). */
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
 * `content` field is the tool's stdout/output as a string. Set `is_error`
 * to true if the tool failed : the model uses this to decide whether to
 * retry, pick a different tool, or give up.
 *
 * @example
 * ```ts
 * {
 *   type: "tool_result",
 *   tool_use_id: "toolu_01ABC...",
 *   content: "total 24\ndrwxr-xr-x 5 user  staff   160 Apr  6 02:18 src\n..."
 * }
 * ```
 */
export interface ToolResultBlock {
  type: "tool_result"
  /** The `id` from the `tool_use` block this result corresponds to. */
  tool_use_id: string
  /** Tool output. Can be a plain string or nested content blocks. */
  content: string | ContentBlock[]
  /** True if the tool failed. */
  is_error?: boolean
  cache_control?: BlockCacheControl
}

/**
 * Union of all content block types observed in v2.1.91 traffic.
 *
 * Used as the element type of {@link Message.content} when content is an
 * array (block-based mode). Plain string content is also still supported
 * for simple user messages but the API normalizes it to a single text block.
 */
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock

// ---------------------------------------------------------------------------
// Message and options types
// ---------------------------------------------------------------------------

/**
 * A single conversation turn.
 *
 * Plain `string` content is supported for simple user messages but the API
 * normalizes it to `[{type:"text", text:"..."}]` internally. New code should
 * always use the array form for consistency with the v2.1.91 wire format.
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
 *     { type: "tool_use", id: "toolu_01...", name: "Bash", input: {command: "ls"} }
 *   ]
 * }
 *
 * // Tool result follow-up:
 * {
 *   role: "user",
 *   content: [{ type: "tool_result", tool_use_id: "toolu_01...", content: "..." }]
 * }
 * ```
 */
export interface Message {
  role: "user" | "assistant"
  content: string | ContentBlock[]
}

/**
 * Options for {@link sendMessage} and friends.
 *
 * Most fields have sensible defaults matching v2.1.91 conversation requests.
 * Override `requestType` for quota checks or title generation, which use
 * different beta flags and parameters.
 */
export interface SendOptions {
  /** Authenticated credentials from {@link getAuth}. */
  auth: AuthResult
  /** Conversation history. Sent in full on every request. */
  messages: Message[]
  /** System prompt blocks. Defaults to {@link SYSTEM_PROMPT} (3 blocks). */
  system?: SystemBlock[]
  /** Model ID. Defaults to {@link DEFAULT_MODEL}. */
  model?: string
  /** Max output tokens. Default: 64000 (matches v2.1.91 opus conversation). */
  maxTokens?: number
  /** Stream the response via SSE. Default: true. */
  stream?: boolean
  /**
   * Request type : controls beta flag set and feature gating.
   * - `"conversation"` (default): full feature set, all 9 flags
   * - `"quota"`: minimal flags, no thinking, no effort (for cheap quota checks)
   * - `"title"`: structured-outputs flag, no thinking (for haiku title gen)
   */
  requestType?: RequestType
  /** Network client used for API transport. */
  networkClient?: NetworkClient
  /**
   * Adaptive thinking config. Pass `false` to disable.
   * Default: `{type:"adaptive"}` for non-haiku models, omitted for haiku.
   *
   * `display` controls visibility of streamed thinking deltas:
   * - `"summarized"`: server streams plaintext `thinking_delta` events.
   *   Default on sonnet-4.6 / opus-4.6 / earlier Claude 4 models.
   * - `"omitted"`: only the encrypted `signature` is returned (no plaintext
   *   deltas). Faster time-to-first-text-token. **Default on opus-4.7 and
   *   Claude Mythos Preview.** To see thinking on those models, the caller
   *   must explicitly request `display: "summarized"`.
   */
  thinking?: { type: "adaptive"; display?: "summarized" | "omitted" } | false
  /**
   * Effort level and/or structured output format.
   * - `effort`: model computation budget (default: `"high"` for non-haiku)
   * - `format`: JSON schema for structured outputs (used by title gen)
   */
  outputConfig?: {
    effort?: string
    format?: { type: string; schema?: unknown }
  }
  /**
   * Tool definitions sent in the request. Pass {@link TOOL_DEFINITIONS} to
   * enable the standard tool set, or provide your own list.
   */
  tools?: Array<{ name: string; description: string; input_schema: unknown }>
  /** Temperature. Default: not sent (API uses its default). */
  temperature?: number
  /**
   * Context-management edits. Live 2.1.118 conversation requests carry
   * `{edits:[{type:"clear_thinking_20251015", keep:"all"}]}` at the top level.
   * Gated by the `context-management-2025-06-27` beta. Server echoes results
   * in `message_delta.context_management.applied_edits`. Pass `null` to opt
   * out, or omit to use the default for `requestType:"conversation"`.
   */
  contextManagement?: { edits: Array<{ type: string; keep?: string }> } | null
  /** Called when a native model thinking block starts. */
  onThinkingStart?: () => MaybePromise<void>
  /** Called for native model thinking chunks as they stream. */
  onThinkingDelta?: (text: string) => MaybePromise<void>
  /** Called when a native model thinking block stops. */
  onThinkingStop?: () => MaybePromise<void>
  /**
   * Called when a `text` content_block stops streaming (server-fired
   * `content_block_stop` for a block whose type was `"text"`).
   *
   * **Why this exists** : the host's response formatter (e.g. `mdstream`)
   * is typically spawned ONCE per `Agent.run` and persists across all
   * tool rounds, but a single `run()` can produce multiple text blocks
   * (one per sub-turn: text → tool → text → tool → …). Without a
   * per-text-block boundary, mdstream's `partial` paragraph buffer
   * accumulates every text-block's chunks into one logical paragraph;
   * at end-of-run it then re-renders the *combined* buffer, smashing
   * two unrelated sentences together with no separator
   * (`…before writing.I have a complete picture…`). Hosts use
   * `onTextStop` to commit the per-block partial : typically by ending
   * and respawning the formatter : at exactly the right moment: AFTER
   * the just-streamed text, BEFORE any tool_use block lands in
   * scrollback. Fires AFTER the completed text block has been pushed
   * onto `blocks[]`, so observers can read the just-finished block.
   *
   * Symmetric with {@link onThinkingStop}.
   */
  onTextStop?: () => MaybePromise<void>
  /**
   * Stream-idle watchdog: if the server stops sending SSE events for this
   * many ms while the request is in-flight (no `message_stop` received
   * yet), the attempt is aborted with `streamErrorType: "stream_idle"`
   * and the outer retry loop tries again.
   *
   * Defaults to `30_000` (30 seconds). The shape we're guarding against
   * is the silent-truncation observed 2026-05-25: a stream that streams
   * partial content (e.g. mid-thinking-block) then stops without a
   * terminator (`message_stop`, `error`, RST_STREAM). Anthropic-side
   * bug; client-side mitigation.
   *
   * Set lower in tests for fast deterministic coverage.
   */
  streamIdleTimeoutMs?: number

  /**
   * Absolute upper bound on a single attempt, in ms. Belt-and-suspenders
   * against pathological hangs that the idle watchdog might miss (e.g.
   * stream that keeps sending pings forever but no real content).
   *
   * Defaults to `30 * 60_000` (30 minutes). Opus 4.7 with adaptive
   * thinking on a hard prompt can legitimately think for many minutes;
   * this cap is generous to avoid false positives.
   */
  attemptHardTimeoutMs?: number

  /**
   * Optional cancellation signal forwarded to the underlying network
   * transport. When the signal aborts mid-request the transport tears
   * down the HTTP/2 stream and the iterator throws an `AbortError`.
   * Used by the REPL's Esc/Ctrl+C handling to cancel an in-flight turn.
   */
  signal?: AbortSignal
}

/**
 * Structured response returned by {@link sendMessage} after streaming completes.
 *
 * Contains all parsed content blocks (thinking, tool_use, text) plus a
 * convenience `text` field with the concatenated text. Use `blocks` when
 * you need the structured form (e.g. to feed back into conversation history),
 * use `text` when you just want the prose.
 *
 * @example
 * ```ts
 * const gen = sendMessage(opts);
 * for await (const chunk of gen) process.stdout.write(chunk);
 * const result = (await gen.next()).value as StreamedResponse;
 * console.log("stop:", result.stopReason);
 * console.log("blocks:", result.blocks.length);
 * console.log("text:", result.text);
 * ```
 */
export interface StreamedResponse {
  /** All content blocks in the order they appeared in the SSE stream. */
  blocks: ContentBlock[]
  /** Concatenated text from text blocks only : convenience accessor. */
  text: string
  /** Stop reason from `message_delta` (e.g. `"end_turn"`, `"tool_use"`, `"max_tokens"`). */
  stopReason: string | null
}

/**
 * A single Server-Sent Event from the streaming Messages API.
 *
 * Event types observed in v2.1.91 capture:
 *   - message_start: message object with id, model, usage
 *   - content_block_start: new content block (text, thinking, tool_use)
 *   - content_block_delta: incremental data:
 *       text_delta: { type: "text_delta", text: "..." }
 *       thinking_delta: { type: "thinking_delta", thinking: "..." }
 *       signature_delta: { type: "signature_delta", signature: "..." }
 *       input_json_delta: { type: "input_json_delta", partial_json: "..." }
 *   - content_block_stop: end of a content block
 *   - message_delta: stop_reason, usage, context_management
 *   - message_stop: end of message
 *   - ping: keepalive
 */
export interface StreamEvent {
  type: string
  index?: number
  delta?: {
    type: string
    text?: string
    thinking?: string
    signature?: string
    partial_json?: string
    stop_reason?: string
    stop_sequence?: string | null
  }
  message?: { id: string; model: string; usage: unknown }
  content_block?: {
    type: string
    text?: string
    thinking?: string
    signature?: string
    id?: string
    name?: string
    input?: Record<string, unknown>
    caller?: { type: string }
  }
  usage?: unknown
  context_management?: { applied_edits: unknown[] }
}

/**
 * Model information returned by GET /v1/models.
 * The API returns a list of models the authenticated user can access.
 */
export interface ModelInfo {
  id: string
  display_name?: string
  type: string
  created_at?: string
}

/**
 * Strip the client-side `[1m]` / `[2m]` suffix from a model ID.
 *
 * The real CLI uses `[1m]` as a UI convention to mean "use this model with
 * the 1M context window variant". The actual API model ID has no suffix :
 * 1M context is activated via the `context-1m-2025-08-07` beta flag instead.
 * This helper strips the suffix so the request body has a valid model ID.
 *
 * @param model - Model ID, possibly with `[1m]` or `[2m]` suffix
 * @returns Model ID with suffix removed
 *
 * @example
 * ```ts
 * normalizeModelForAPI("claude-opus-4-7[1m]") // → "claude-opus-4-7"
 * normalizeModelForAPI("claude-sonnet-4-6")   // → "claude-sonnet-4-6"
 * ```
 *
 * @see cc-03312026/src/utils/model/model.ts:normalizeModelStringForAPI()
 */
export function normalizeModelForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, "")
}

/**
 * Check whether a model string requests the 1M context window (has `[1m]` suffix).
 *
 * Used by the beta-flag builder to decide whether to include
 * `context-1m-2025-08-07`. Case-insensitive.
 *
 * @param model - Model ID to inspect
 * @returns True if the model has a `[1m]` suffix
 */
export function has1mContext(model: string): boolean {
  return /\[1m\]/i.test(model)
}

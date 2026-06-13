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
 * An encrypted ("redacted") reasoning block. The API emits these instead of a
 * plain {@link ThinkingBlock} when its safety systems encrypt the model's
 * reasoning. The `data` payload is opaque : we never introspect it, but we
 * MUST round-trip it verbatim. The Messages API rejects any request whose
 * latest assistant turn dropped or altered a `thinking`/`redacted_thinking`
 * block ("blocks ... cannot be modified. These blocks must remain as they were
 * in the original response."), so the SSE parser stores these blocks and the
 * send path re-emits them unchanged. See `src/client.ts` content_block_start.
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
 * An image input block (Anthropic `vision`). One of three mutually-exclusive
 * `source` shapes:
 *
 * - `base64`: inline bytes + `media_type` (e.g. `image/jpeg`). What the CLI
 *   sends today; verified on the wire.
 * - `url`: Anthropic fetches the image (not available on Bedrock/Vertex).
 * - `file`: a Files API `file_id` (beta `files-api-2025-04-14`). Note the wire
 *   `source.type` is `"file"`, not `"file_id"`.
 *
 * Accepted formats: JPEG, PNG, GIF, WebP. See
 * `private/multimodality-ingestion/anthropic/10-anthropic-image-ingestion.md`.
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
 * A document input block (Anthropic PDF / plain-text support). Same `source`
 * trichotomy as {@link ImageBlock} plus an inline `text` source for plain text.
 * Optional `title` / `context` / `citations` mirror the Files API doc.
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
 * Union of all content block types observed in v2.1.91 traffic.
 *
 * Used as the element type of {@link Message.content} when content is an
 * array (block-based mode). Plain string content is also still supported
 * for simple user messages but the API normalizes it to a single text block.
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
  /**
   * Conversation role.
   *
   * - `"user"`, `"assistant"`: the bread-and-butter pair every model
   *   supports.
   * - `"system"`: **mid-conversation** operator message, gated by the
   *   `mid-conversation-system-2026-04-07` beta (opus-4-6+ / sonnet-4-6).
   *   Distinct from the TOP-LEVEL `system` field on the request body
   *   (which is the system prompt prefix). When the beta isn't sent,
   *   the server 400s on a `role:"system"` entry inside `messages[]`.
   */
  role: "user" | "assistant" | "system"
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
   * Speed mode. Anthropic only. `"fast"` opts into the
   * `fast-mode-2026-02-01` beta and sends `speed: "fast"` on the wire,
   * unlocking the premium dispatch tier (~2.5x output tok/s).
   *
   * Pricing implications:
   * - Opus 4.8 fast: $10 in / $50 out per MTok (2x standard $5/$25).
   * - Opus 4.5/4.6/4.7 fast: $30 in / $150 out per MTok (6x standard).
   *
   * Capability-gated: ignored on models whose registry entry doesn't
   * declare `speedFast: true`. Default: omitted (server treats as
   * `"normal"`).
   */
  speed?: "normal" | "fast"
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
   * Upper bound, in ms, on the request-send + wait-for-response-headers
   * phase (i.e. everything BEFORE the first byte of the SSE body). The
   * streaming idle watchdog (`streamIdleTimeoutMs`) only arms once we
   * start reading the response body, so without this knob a stalled
   * upload, or a server that accepts the POST but never returns response
   * headers, hangs `await networkClient.request()` forever with nothing
   * to abort it and nothing for the retry loop to catch.
   *
   * Observed 2026-05-28 (session b00e2d52): a ~2.3MB POST sat in
   * "Sending request" for 13h, no watchdog, no retry. When this deadline
   * trips, the attempt is aborted with `streamErrorType: "stream_idle"`
   * and the outer retry loop tries again (against a fresh connection,
   * since the transport evicts the wedged HTTP/2 session on abort).
   *
   * Defaults to `120_000` (2 minutes). Anthropic returns the 200 SSE
   * headers within seconds regardless of context size (the long
   * prompt-ingest/first-token latency happens AFTER headers, on the body
   * stream, where `streamIdleTimeoutMs` + server `ping` events apply), so
   * 2 minutes is generous enough to never false-trip on a healthy link.
   *
   * Set lower in tests for fast deterministic coverage.
   */
  responseHeadersTimeoutMs?: number

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
  /**
   * Stop-reason categorization from Anthropic's `message_delta.stop_details`.
   * Populated on `stopReason: "refusal"` (and other categorized stops the
   * server may add later). `null` on normal end_turn/tool_use/max_tokens.
   *
   * Shape mirrors what the server sends: opaque `type` string the host can
   * route on, optional `message` for display. New in opus-4-7+; ignored on
   * older models that never populate it.
   *
   * @see private/research/2026-05-28-llm-providers/02-wire-snapshots.md
   */
  stopDetails?: { type: string; message?: string } | null
  /**
   * Billed token usage for THIS turn, as reported by the provider.
   *
   * Anthropic ships `input_tokens` + cache counters at `message_start`
   * (cache lookup happens during prefill) and the final `output_tokens`
   * in the closing `message_delta`. We merge both into this single
   * snapshot so the caller (the agent loop) can persist the turn's exact
   * footprint to the session log via `appendAssistant`. Absent when the
   * stream never reported usage (e.g. an empty/aborted turn).
   *
   * Field names mirror the Anthropic wire (`input_tokens`, etc.) so this
   * threads unchanged into `AssistantRecord.usage` and the session-tokens
   * accumulator. See `src/session-usage.ts`.
   */
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

/**
 * A single Server-Sent Event from the streaming Messages API.
 *
 * Event types observed in v2.1.91 capture:
 *   - message_start: message object with id, model, usage
 *   - content_block_start: new content block (text, thinking, tool_use)
 *   - content_block_delta: incremental data:
 *       text_delta: \{ type: "text_delta", text: "..." \}
 *       thinking_delta: \{ type: "thinking_delta", thinking: "..." \}
 *       signature_delta: \{ type: "signature_delta", signature: "..." \}
 *       input_json_delta: \{ type: "input_json_delta", partial_json: "..." \}
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
    /** Opaque payload for `redacted_thinking` blocks. */
    data?: string
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

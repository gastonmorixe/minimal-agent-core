/**
 * Client module: Messages API with streaming, pretty debug logging, and 401 retry.
 *
 * Updated to match CLI v2.1.118 traffic (captured 2026-04-25):
 *   - Block-based message content (text, thinking, tool_use, tool_result)
 *   - Adaptive thinking with redacted thinking + signatures
 *   - Effort parameter (output_config.effort)
 *   - Per-request-type beta flags
 *   - 64K max_tokens default (was 8192)
 *   - SSE parsing for signature_delta and input_json_delta
 */

import { type AuthResult, readCredentials } from "./auth.ts"
import { type CacheUsage, formatCacheLine, getCacheDetector, snapshotRequest } from "./cache.ts"
import {
  API_URL,
  buildHeaders,
  DEFAULT_MODEL,
  type RequestType,
  SYSTEM_PROMPT,
  type SystemBlock,
} from "./headers.ts"
import { buildMetadata, getSessionId } from "./metadata.ts"
import { redactHeaders } from "./net-dbg.ts"
import { defaultNetworkClient, type NetworkClient } from "./network/index.ts"
import { broadcastResponseRateLimits } from "./quota-broadcast.ts"
import { addSessionUsage } from "./session-tokens.ts"
import { GLOBAL_STATUS_BUS } from "./status.ts"
import { clampWithHint } from "./truncate-hint.ts"

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
interface StreamEvent {
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

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[39m`,
  brightGreen: (s: string) => `\x1b[92m${s}\x1b[39m`,
}

// ---------------------------------------------------------------------------
// Debug logging : pretty-printed to stderr
// ---------------------------------------------------------------------------

/**
 * Check debug mode at call time (not import time) so that --debug flag
 * in index.ts can set process.env.DEBUG before the first request.
 */
export function isDebug(): boolean {
  return !!process.env.DEBUG
}

/**
 * When verbose is enabled (--verbose flag or VERBOSE=1), debug output is not
 * truncated: full system blocks, full message previews, untrimmed tokens.
 */
export function isVerbose(): boolean {
  return !!process.env.VERBOSE
}

/**
 * When --show-hidden-chars (or MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1) is on,
 * debug output reveals invisible characters as faint glyphs : same idea
 * as the input editor's show-hidden mode (see editor-renderer.ts).
 *
 * Without this, multi-line tool descriptions (e.g. "Bash: ...\n\nThe working
 * directory...") wrap onto real lines in the debug log and visually break
 * the structured key/value layout.
 */
export function isShowHiddenChars(): boolean {
  return process.env.MINIMAL_AGENT_SHOW_HIDDEN_CHARS === "1"
}

/**
 * Replace invisible characters with faint visual indicator glyphs:
 *   space → ·, tab → →, LF → ↵, CR → ␍.
 * No-op unless `--show-hidden-chars` is active.
 *
 * Kept independent of editor-renderer.ts's `markHidden` because here we
 * also want to fold newlines (which the editor handles structurally) so
 * the debug log keeps each value on a single line.
 */
function revealHidden(s: string): string {
  if (!isShowHiddenChars()) return s
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === " ")
      out += "\x1b[2m\u00b7\x1b[22m" // ·
    else if (ch === "\t")
      out += "\x1b[2m\u2192\x1b[22m" // →
    else if (ch === "\n")
      out += "\x1b[2m\u21b5\x1b[22m" // ↵
    else if (ch === "\r")
      out += "\x1b[2m\u240d\x1b[22m" // ␍
    else out += ch
  }
  return out
}

/**
 * Truncate `s` to `max` chars unless verbose mode is on, then optionally
 * reveal hidden characters. Truncation operates on the raw string so the
 * `(+Nch)` count reflects source characters, not glyph-substituted output.
 */
function truncate(s: string, max: number): string {
  // Verbose mode disables the cap; otherwise delegate to the shared
  // `clampWithHint` so debug dumps speak the same `...(+Nch)` dialect as
  // tool transcript previews (see src/truncate-hint.ts).
  const body = isVerbose() ? s : clampWithHint(s, max, "ch")
  return revealHidden(body)
}

/**
 * Render a single ContentBlock as a short structural token for debug output.
 *
 * One token per block; no color, no truncation : the caller composes them
 * and applies {@link truncate} to the joined result. The discriminator
 * (`b.type`) is the wire-protocol literal from {@link ContentBlock}, so the
 * exhaustiveness `never` check below will fail at compile time the moment
 * Anthropic adds a new block variant : pointing right at this switch.
 *
 * Newline-bearing payloads (text, tool_result strings) are JSON-stringified
 * so embedded `\n` becomes the escape `\n`, keeping each block on one line
 * in the debug log.
 */
function previewBlock(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return JSON.stringify(b.text)
    case "thinking":
      return `thinking(${b.thinking.length}ch)`
    case "tool_use": {
      const keys = Object.keys(b.input ?? {}).join(",")
      return `tool_use(${b.name}#${shortId(b.id)})${keys ? `{${keys}}` : ""}`
    }
    case "tool_result": {
      const inner =
        typeof b.content === "string"
          ? JSON.stringify(b.content)
          : b.content.map(previewBlock).join(" + ")
      const err = b.is_error ? "!" : ""
      return `tool_result${err}(${shortId(b.tool_use_id)}) ${inner}`
    }
    default: {
      // Compile-time exhaustiveness. If ContentBlock gains a member, tsc
      // errors here ("Type 'XBlock' is not assignable to type 'never'").
      // Runtime fallback below keeps the agent alive on unknown shapes.
      const _exhaustive: never = b
      void _exhaustive
      return `unknown(${(b as { type?: string } | null)?.type ?? "?"})`
    }
  }
}

/** Last 6 chars of a `toolu_...` id : enough to pair use↔result within a dump. */
function shortId(id: string): string {
  return id.slice(-6)
}

/**
 * Summarize a `Message.content` (string or block array) for non-verbose
 * debug. Caps at `max` chars with the same `...(+Nch)` convention as
 * {@link truncate}.
 */
function previewContent(content: string | ContentBlock[], max = 80): string {
  if (typeof content === "string") return truncate(content, max)
  return truncate(content.map(previewBlock).join("  ⟶  "), max)
}

function debugHeader(label: string): void {
  if (!isDebug()) return
  console.error(`\n${c.bold(c.cyan(`--- ${label} ---`))}`)
}

function debugKV(key: string, value: string): void {
  if (!isDebug()) return
  console.error(`  ${c.dim(key + ":")} ${value}`)
}

/** Print request headers sorted alphabetically, with auth tokens redacted. */
function debugHeaders(headers: Record<string, string>): void {
  if (!isDebug()) return
  console.error(`  ${c.bold("Headers:")}`)
  const safeHeaders = redactHeaders(headers)
  const sorted = Object.entries(safeHeaders).sort(([a], [b]) => a.localeCompare(b))
  for (const [k, v] of sorted) {
    console.error(`    ${c.yellow(k)}: ${revealHidden(v)}`)
  }
}

/**
 * Pretty-print the request body, with special handling for:
 *   - messages: show count + role/content preview per message
 *   - system: label blocks as "billing" or "identity" based on content
 *   - metadata.user_id: parse the JSON string and show fields individually
 */
function debugBody(body: Record<string, unknown>): void {
  if (!isDebug()) return
  console.error(`  ${c.bold("Body:")}`)
  for (const [k, v] of Object.entries(body)) {
    if (k === "messages") {
      const msgs = v as Message[]
      console.error(`    ${c.yellow("messages")}: ${c.dim(`[${msgs.length} message(s)]`)}`)
      for (const msg of msgs) {
        const isCached = (() => {
          if (typeof msg.content === "string") return false
          const last = msg.content[msg.content.length - 1] as
            | { cache_control?: unknown }
            | undefined
          return Boolean(last?.cache_control)
        })()
        // Bright bold green annotation marks where the cache_control
        // breakpoint sits in this request. Everything before it (system,
        // tools, prior messages) is what the API actually serves from cache;
        // see docs/caching.md for the prefix-checkpoint mental model.
        const cc = isCached ? ` ${c.bold(c.brightGreen("[← cached prefix ends here]"))}` : ""
        const preview = previewContent(msg.content, 80)
        console.error(`      ${c.green(msg.role)}${cc}: ${c.dim(preview)}`)
      }
    } else if (k === "system") {
      const sys = v as Array<{
        type: string
        text: string
        cache_control?: unknown
      }>
      console.error(`    ${c.yellow("system")}: ${c.dim(`[${sys.length} block(s)]`)}`)
      for (let i = 0; i < sys.length; i++) {
        const block = sys[i]
        // Label blocks by their role (see SYSTEM_PROMPT docs in headers.ts)
        const label = block.text.startsWith("x-anthropic-billing-header")
          ? "billing"
          : block.text.startsWith("You are Claude")
            ? "identity"
            : `block ${i}`
        const cc = block.cache_control ? ` ${c.bold(c.brightGreen("[cached]"))}` : ""
        const preview = truncate(block.text, 80)
        console.error(`      ${c.magenta(label)}${cc}: ${c.dim(preview)}`)
      }
    } else if (k === "tools") {
      const tools = v as Array<{ name: string; description?: string }>
      console.error(`    ${c.yellow("tools")}: ${c.dim(`[${tools.length} tool(s)]`)}`)
      for (const tool of tools) {
        const desc = truncate(tool.description ?? "", 80)
        console.error(`      ${c.magenta(tool.name)}: ${c.dim(desc)}`)
      }
    } else if (k === "metadata") {
      const meta = v as { user_id: string }
      console.error(`    ${c.yellow("metadata.user_id")}:`)
      try {
        const parsed = JSON.parse(meta.user_id)
        for (const [mk, mv] of Object.entries(parsed)) {
          console.error(`      ${c.magenta(mk)}: ${revealHidden(String(mv))}`)
        }
      } catch {
        console.error(`      ${revealHidden(meta.user_id)}`)
      }
    } else {
      console.error(`    ${c.yellow(k)}: ${revealHidden(JSON.stringify(v))}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Rate limit header parsing
// ---------------------------------------------------------------------------

/**
 * Convert a raw ratelimit header value to a human-readable annotation.
 *
 * The Anthropic API returns unified rate limit headers with this naming pattern:
 *   anthropic-ratelimit-unified[-<window>]-<field>
 *
 * Windows: "5h" (5-hour rolling), "7d" (7-day rolling), or none (aggregate).
 * Fields: reset (unix timestamp), utilization (0.0-1.0), status (allowed/rejected),
 *   fallback-percentage, overage-status, overage-disabled-reason,
 *   representative-claim (which window is billing-relevant).
 */
function humanizeRatelimitValue(key: string, value: string): string {
  if (key.endsWith("-reset")) {
    const resetAt = Number(value) * 1000 // API sends seconds, we need ms
    const now = Date.now()
    const diffMs = resetAt - now
    if (diffMs <= 0) return "now"
    const mins = Math.floor(diffMs / 60_000)
    const hrs = Math.floor(mins / 60)
    if (hrs > 0) return `in ${hrs}h ${mins % 60}m`
    return `in ${mins}m`
  }
  if (key.endsWith("-utilization")) {
    return `${(Number(value) * 100).toFixed(1)}%`
  }
  if (key.endsWith("-fallback-percentage")) {
    return `${(Number(value) * 100).toFixed(0)}%`
  }
  if (key.endsWith("-status")) {
    if (value === "allowed") return c.green("allowed")
    if (value === "rejected") return c.red("rejected")
    return value
  }
  if (key.endsWith("-disabled-reason")) {
    // These reasons come from `P04()` (L468510-468524) which checks
    // cachedExtraUsageDisabledReason.
    const map: Record<string, string> = {
      out_of_credits: "no credits remaining",
      overage_not_provisioned: "overage not set up",
      org_level_disabled: "disabled by org admin",
    }
    return map[value] ?? value
  }
  return ""
}

/**
 * Print a summary of rate limit status after the per-header listing.
 * Extracts the 5h and 7d windows and shows utilization, status, and reset time.
 */
function formatRatelimitSummary(rl: Map<string, string>): void {
  const windows = new Map<string, { util?: number; status?: string; reset?: number }>()
  for (const [k, v] of rl) {
    const match = k.match(/^anthropic-ratelimit-unified-([\w]+)-(\w+)$/)
    if (!match) continue
    const window = match[1]
    const field = match[2]
    if (!windows.has(window)) windows.set(window, {})
    const w = windows.get(window)!
    if (field === "utilization") w.util = Number(v)
    if (field === "status") w.status = v
    if (field === "reset") w.reset = Number(v) * 1000
  }

  const ovStatus = rl.get("anthropic-ratelimit-unified-overage-status")
  const ovReason = rl.get("anthropic-ratelimit-unified-overage-disabled-reason")
  const rep = rl.get("anthropic-ratelimit-unified-representative-claim")

  console.error(`\n  ${c.bold("Rate limit summary:")}`)
  for (const [window, info] of [...windows.entries()].sort()) {
    // Skip non-window entries (overage, fallback, representative-claim are handled separately)
    if (window === "overage" || window === "fallback" || window === "representative") continue
    if (!info.util && !info.status && !info.reset) continue
    const label =
      window === "5h"
        ? "5-hour"
        : window === "7d"
          ? "7-day"
          : window.startsWith("7d_")
            ? `7-day (${window.slice(3)})`
            : window
    const pct = info.util != null ? `${(info.util * 100).toFixed(1)}% used` : "?"
    const statusColor = info.status === "allowed" ? c.green(info.status) : c.red(info.status!)
    let resetStr = ""
    if (info.reset) {
      const diffMs = info.reset - Date.now()
      if (diffMs > 0) {
        const hrs = Math.floor(diffMs / 3_600_000)
        const mins = Math.floor((diffMs % 3_600_000) / 60_000)
        resetStr = `, resets in ${hrs}h ${mins}m`
      }
    }
    console.error(`    ${c.cyan(label)}: ${pct} : ${statusColor}${resetStr}`)
  }
  if (ovStatus) {
    const ovColor = ovStatus === "allowed" ? c.green("enabled") : c.red("disabled")
    const reason = ovReason
      ? ` (${humanizeRatelimitValue("x-disabled-reason", ovReason) || ovReason})`
      : ""
    console.error(`    ${c.cyan("overage")}: ${ovColor}${reason}`)
  }
  if (rep) {
    console.error(`    ${c.cyan("billing window")}: ${rep.replace("_", " ")}`)
  }
}

/**
 * Pretty-print all response headers, with human annotations for ratelimit
 * headers and a summary block at the end.
 */
function debugResponse(status: number, headers: Headers): void {
  if (!isDebug()) return
  debugHeader(`Response ${status >= 400 ? c.red(String(status)) : c.green(String(status))}`)
  const entries: [string, string][] = []
  const ratelimitEntries = new Map<string, string>()
  headers.forEach((v, k) => entries.push([k, v]))
  entries.sort(([a], [b]) => a.localeCompare(b))

  for (const [k, v] of entries) {
    const human = k.startsWith("anthropic-ratelimit-") ? humanizeRatelimitValue(k, v) : ""
    const annotation = human ? ` ${c.dim(`(${human})`)}` : ""
    console.error(`    ${c.yellow(k)}: ${v}${annotation}`)
    if (k.startsWith("anthropic-ratelimit-")) {
      ratelimitEntries.set(k, v)
    }
  }

  if (ratelimitEntries.size > 0) {
    formatRatelimitSummary(ratelimitEntries)
  }
}

// ---------------------------------------------------------------------------
// Streaming response parser
// ---------------------------------------------------------------------------

/**
 * Parse a Server-Sent Events stream into typed event objects.
 *
 * The Anthropic streaming API uses standard SSE format:
 *   event: <type>\n
 *   data: <json>\n\n
 *
 * We only look at `data:` lines since the event type is also in the JSON.
 * The stream ends with `data: [DONE]` (not standard SSE, but conventional).
 *
 * Uses a line-buffered approach: we accumulate bytes until we see newlines,
 * then process complete lines. This handles partial chunks from the network
 * correctly (a single SSE event may arrive across multiple TCP segments).
 *
 * @yields Parsed stream events from complete SSE `data:` lines.
 */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? "" // keep incomplete last line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim()
          if (data === "[DONE]") return
          try {
            yield JSON.parse(data) as StreamEvent
          } catch {
            // skip malformed events : shouldn't happen but defensive
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Streaming status helpers
// ---------------------------------------------------------------------------

/**
 * Format a byte count as a short human-readable string for status labels.
 * Examples: 0 → "0 B", 512 → "512 B", 2048 → "2.0 KB", 1572864 → "1.5 MB".
 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Best-effort extraction of a one-line hint from a (possibly partial) tool_use
 * input JSON string while it is still streaming. Tries fast regex extraction
 * first (works on partial JSON), then falls back to JSON.parse.
 *
 * Per-tool prioritization mirrors the most useful "what is it actually doing"
 * field: file_path for Read/Write/Edit, command for Bash, pattern for Grep,
 * url for WebFetch, query for the search tools, etc. Falls back to the first
 * string-valued top-level key when no known field is found.
 *
 * @returns A short hint string (≤80 chars, no newlines) or "" if nothing
 *   could be extracted yet.
 */
function extractToolHint(toolName: string, partialJson: string): string {
  if (partialJson.length === 0) return ""

  const fieldsByTool: Record<string, string[]> = {
    Bash: ["command"],
    Read: ["file_path", "path"],
    Write: ["file_path", "path"],
    Edit: ["file_path", "path"],
    MultiEdit: ["file_path", "path"],
    Grep: ["pattern", "path"],
    Glob: ["pattern", "path"],
    WebFetch: ["url"],
    WebSearch: ["query"],
    show_diff: ["title"],
  }
  const candidates = fieldsByTool[toolName] ?? [
    "file_path",
    "path",
    "command",
    "pattern",
    "url",
    "query",
    "title",
    "name",
  ]

  // Regex pass: tolerates unterminated strings and incomplete JSON.
  // Captures the contents of the first matching `"<key>"\s*:\s*"..."` pair.
  for (const key of candidates) {
    const re = new RegExp(String.raw`"${key}"\s*:\s*"((?:\\.|[^"\\])*)`, "")
    const m = re.exec(partialJson)
    if (m && m[1]) return shortenHint(unescapeJsonish(m[1]))
  }

  // Fallback: try a full JSON parse and surface the first string field.
  try {
    const obj = JSON.parse(partialJson) as Record<string, unknown>
    for (const key of candidates) {
      const v = obj[key]
      if (typeof v === "string" && v.length > 0) return shortenHint(v)
    }
    for (const v of Object.values(obj)) {
      if (typeof v === "string" && v.length > 0) return shortenHint(v)
    }
  } catch {
    // partial : nothing more to do
  }
  return ""
}

function unescapeJsonish(s: string): string {
  // Cheap unescape sufficient for hint display (not a full JSON string parser).
  return s
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\r/g, "")
    .replace(/"/g, '"')
    .replace(/\\\\/g, "\\")
}

function shortenHint(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim()
  if (oneLine.length <= 80) return oneLine
  return `${oneLine.slice(0, 77)}…`
}

// ---------------------------------------------------------------------------
// sendMessage : streaming, returns async iterable of text chunks
// ---------------------------------------------------------------------------

/**
 * Send a message to the Messages API and yield streamed text chunks.
 *
 * The core HTTP layer. Builds the request body matching v2.1.91 wire format,
 * POSTs to `/v1/messages?beta=true`, parses the SSE response, and yields
 * text chunks via async generator. The full structured response (with
 * thinking and tool_use blocks) is available as the generator's return value.
 *
 * **Behaviors replicated from the real CLI:**
 * - Per-request-type beta flags (via {@link SendOptions.requestType})
 * - Adaptive thinking for non-haiku models
 * - Effort parameter (`output_config.effort: "high"`) for non-haiku
 * - Model-specific gating (no thinking/effort for haiku, no context-1m for sonnet)
 * - 401 retry with token refresh (mirrors CLI's `onAuth401` pattern)
 * - SSE parsing for `text_delta`, `signature_delta`, `input_json_delta`
 *
 * **Two ways to get the result:**
 * 1. Iterate the generator for live text chunks (use this for streaming UI)
 * 2. Await the return value for the full {@link StreamedResponse} with all blocks
 *
 * @param opts - Request options. See {@link SendOptions} for all fields.
 * @yields Text chunks from `text_delta` SSE events as they arrive
 * @returns Final {@link StreamedResponse} after stream completes
 *
 * @example
 * ```ts
 * // Streaming text only:
 * for await (const chunk of sendMessage({ auth, messages })) {
 *   process.stdout.write(chunk);
 * }
 *
 * // Get full structured response:
 * const result = await sendMessageFull({ auth, messages });
 * for (const block of result.blocks) {
 *   if (block.type === "tool_use") console.log("called:", block.name);
 * }
 * ```
 *
 * @throws Error if the API returns a non-2xx status (after 401 retry)
 */
export async function* sendMessage(
  opts: SendOptions,
): AsyncGenerator<string, StreamedResponse, undefined> {
  const {
    auth,
    messages,
    system = SYSTEM_PROMPT,
    model: rawModel = DEFAULT_MODEL,
    maxTokens = 64000,
    stream = true,
    requestType = "conversation",
    thinking = { type: "adaptive" as const },
    outputConfig = { effort: "medium" },
    tools,
    temperature,
    contextManagement,
    onThinkingStart,
    onThinkingDelta,
    onThinkingStop,
    onTextStop,
    networkClient = defaultNetworkClient,
    signal,
  } = opts

  // Strip client-side [1m] suffix : API activation is via beta flag
  const model = normalizeModelForAPI(rawModel)

  const sessionId = getSessionId()
  // Pass rawModel so buildBetaFlags sees [1m] and adds context-1m flag
  const headers = buildHeaders(auth, sessionId, requestType, rawModel)
  const metadata = buildMetadata(auth)

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    stream,
    system,
    messages,
    metadata,
  }

  // Thinking: only for models that support it (not haiku)
  // v2.1.91 capture: opus sends thinking:{type:"adaptive"}, haiku does not
  const isHaiku = model.includes("haiku")
  if (thinking && !isHaiku) {
    body.thinking = thinking
  }

  // Output config: effort and/or structured format
  // v2.1.91: effort only sent for models that support it (not haiku)
  if (outputConfig && !isHaiku) {
    body.output_config = outputConfig
  } else if (outputConfig?.format) {
    // Structured output format can be sent even for haiku (used in title gen)
    body.output_config = { format: outputConfig.format }
  }

  // Tools: include if provided
  if (tools && tools.length > 0) {
    body.tools = tools
  }

  // Temperature: only sent explicitly when set (title gen uses 1)
  if (temperature != null) {
    body.temperature = temperature
  }

  // Context management: live 2.1.118 conversation requests carry
  //   { edits: [{ type: "clear_thinking_20251015", keep: "all" }] }
  // at the top level. Gated by the context-management-2025-06-27 beta.
  // The clear_thinking strategy requires thinking to be enabled, which is the
  // same predicate as `!isHaiku` (haiku has no thinking, so we never set
  // body.thinking for it above). Using !isHaiku here keeps the gate aligned
  // with the thinking gate above and easier to reason about.
  // Pass contextManagement: null to opt out; omit to use the conversation
  // default; pass a custom object to override.
  if (contextManagement === undefined) {
    if (requestType === "conversation" && !isHaiku) {
      body.context_management = {
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      }
    }
  } else if (contextManagement !== null) {
    body.context_management = contextManagement
  }

  debugHeader(`POST ${API_URL}`)
  debugKV("model", model)
  debugKV("stream", String(stream))
  debugKV("max_tokens", String(maxTokens))
  debugKV("request_type", requestType)
  if (thinking) debugKV("thinking", JSON.stringify(thinking))
  if (outputConfig) debugKV("output_config", JSON.stringify(outputConfig))
  debugHeaders(headers)
  debugBody(body as Record<string, unknown>)

  const requestStatus = GLOBAL_STATUS_BUS.create("Sending request", {
    notificationId: "network.request",
    category: "network",
  })

  const reqSnapshot = snapshotRequest(body, model)
  const detector = getCacheDetector()

  const serializedBody = JSON.stringify(body)

  try {
    const doRequest = async (token: string) => {
      const h = { ...headers }
      if (h.authorization) h.authorization = `Bearer ${token}`
      else if (h["x-api-key"]) h["x-api-key"] = token

      return networkClient.request({
        label: "messages.send",
        method: "POST",
        url: API_URL,
        headers: h,
        body: serializedBody,
        signal,
      })
    }

    let response = await doRequest(auth.token)
    requestStatus.update(stream ? "Waiting for response" : "Reading response")

    debugResponse(response.status, response.headers)

    // 401 retry with token refresh : mirrors onAuth401 pattern (L751090-751112).
    // Goal: when the access token expires during a long-running session,
    // refresh transparently and continue without forcing the user to
    // restart anything. Surface the refresh in the status bar, then
    // resume the same in-flight turn.
    //
    // Multi-process race mitigation (May 2026): when many agent processes
    // share one credential entry, server-side refresh-token rotation makes
    // each refresh invalidate the access tokens cached by every OTHER
    // process. They each 401 on their next request, refresh, invalidate
    // the previous one, and the cycle never settles. Net-dbg trace from
    // session c0ab6ba6: 24/105 requests in a single 5-minute window
    // returned 401, with 22 refreshes (one outright `invalid_grant` :
    // refresh token already burned by another agent).
    //
    // Fix: on 401, re-read the credential store BEFORE calling
    // auth.refresh(). If another process has already written a fresher
    // access token, use that directly : no oauth round-trip, no rotation,
    // no race. Only refresh if the store still has the same token we
    // just got 401 on (i.e. WE are the freshest cache holder, the token
    // genuinely expired). Collapses N concurrent refreshes per "true
    // expiry" event into 1.
    if (response.status === 401 && auth.refresh) {
      debugHeader(c.yellow("401 : token expired"))

      // Step 1: store-first. Cheap (single read of keychain or local
      // JSON file), synchronous, no network. Fail-quiet on any read
      // error : fall through to the refresh path.
      let recovered = false
      try {
        const fresh = readCredentials()
        const freshToken = fresh?.claudeAiOauth?.accessToken
        if (freshToken && freshToken !== auth.token) {
          requestStatus.update("Auth refreshed elsewhere, retrying...", {
            notificationId: "auth.refresh",
            category: "auth",
          })
          auth.token = freshToken
          response = await doRequest(freshToken)
          if (response.ok) {
            recovered = true
            requestStatus.update(stream ? "Waiting for response" : "Reading response", {
              notificationId: "network.request",
              category: "network",
            })
          }
        }
      } catch {
        // Credential read failures are non-fatal; the refresh path below
        // is the authoritative recovery anyway.
      }

      // Step 2: still 401 (or store had no fresher token) → do our
      // own refresh.
      if (!recovered && response.status === 401) {
        requestStatus.update("Auth token expired, refreshing...", {
          notificationId: "auth.refresh",
          category: "auth",
        })
        try {
          const refreshed = await auth.refresh()
          // Persist on the AuthResult so subsequent turns reuse the new
          // token without paying another 401+refresh round-trip.
          auth.token = refreshed.token
          requestStatus.update("Auth refreshed, resuming...", {
            notificationId: "auth.refresh",
            category: "auth",
          })
          response = await doRequest(refreshed.token)
          requestStatus.update(stream ? "Waiting for response" : "Reading response", {
            notificationId: "network.request",
            category: "network",
          })
          if (response.status === 401) {
            throw new Error(
              "401 after token refresh. The stored credentials are stale : " +
                "run `minimal-agent --login` (or `claude`) to re-login.",
            )
          }
        } catch (e) {
          throw new Error(`Token refresh failed: ${e instanceof Error ? e.message : String(e)}`, {
            cause: e,
          })
        }
      }
    }

    if (!response.ok) {
      const errorBody = await response.text()
      if (isDebug()) {
        debugHeader(c.red(`Error ${response.status}`))
        console.error(`  ${truncate(errorBody, 500)}`)
      }
      throw new Error(`API ${response.status}: ${errorBody}`)
    }

    // Cache + broadcast the rate-limit snapshot from THIS response.
    // The `quota-status` plugin's live-area slot subscribes to
    // `quota.headersReceived` (via its manifest's `refreshOn`) so the
    // footer updates within milliseconds of every successful API call :
    // no waiting for the 5-min heartbeat.
    broadcastResponseRateLimits(response.headers)

    // Non-streaming path (used in tests)
    if (!stream) {
      const raw = await response.text()
      const data = JSON.parse(raw) as {
        content: Array<{ type: string; text?: string }>
      }
      const text = data.content.find((c) => c.type === "text")?.text ?? ""
      yield text
      return {
        blocks: data.content as ContentBlock[],
        text,
        stopReason: "end_turn",
      }
    }

    // Streaming path : parse SSE and collect all content blocks
    if (!response.body) throw new Error("No response body for stream")

    const blocks: ContentBlock[] = []
    let currentBlock: Partial<ContentBlock> | null = null
    let fullText = ""
    let stopReason: string | null = null
    let sawStreamEvent = false

    // Accumulators for the current block being streamed
    let thinkingSig = ""
    let toolJsonParts = ""

    // Per-block status tracking. We keep these around so input_json_delta
    // events (which don't repeat the tool name) can rebuild a useful label.
    let activeToolName = ""
    let lastStatusUpdateAt = 0
    let lastStatusBytes = 0
    const STATUS_THROTTLE_MS = 100
    const STATUS_THROTTLE_BYTES = 2048

    for await (const event of parseSSE(response.body)) {
      if (!sawStreamEvent) {
        sawStreamEvent = true
        // Generic fallback : overridden by the per-block-type labels below
        // as soon as we see a content_block_start. Without this fallback, a
        // stream that begins with something unexpected would still show the
        // pre-stream label ("Waiting for response") indefinitely.
        requestStatus.update("Receiving stream")
      }
      switch (event.type) {
        case "message_start": {
          // Anthropic returns the full `usage` payload right at message_start,
          // since cache lookup happens during prefill : before any output
          // tokens are generated. Use this to (a) print the per-turn cache
          // line under --debug and (b) feed the always-on anomaly detector.
          const usage = event.message?.usage as CacheUsage | undefined
          if (usage) {
            if (isDebug()) console.error(formatCacheLine(usage))
            detector.observe(usage, reqSnapshot)
            addSessionUsage(usage)
          }
          requestStatus.update("Receiving stream")
          break
        }

        case "content_block_start": {
          const cb = event.content_block
          if (!cb) break

          if (cb.type === "thinking") {
            const initialThinking = cb.thinking ?? ""
            currentBlock = {
              type: "thinking",
              thinking: initialThinking,
              signature: cb.signature ?? "",
            }
            thinkingSig = cb.signature ?? ""
            requestStatus.update("Thinking")
            await onThinkingStart?.()
            if (initialThinking) await onThinkingDelta?.(initialThinking)
          } else if (cb.type === "tool_use") {
            currentBlock = {
              type: "tool_use",
              id: cb.id ?? "",
              name: cb.name ?? "",
              input: cb.input ?? {},
              caller: cb.caller,
            }
            toolJsonParts = ""
            activeToolName = cb.name ?? "tool"
            lastStatusBytes = 0
            lastStatusUpdateAt = Date.now()
            requestStatus.update(`Calling ${activeToolName}: streaming input`)
          } else if (cb.type === "text") {
            currentBlock = { type: "text", text: cb.text ?? "" }
            requestStatus.update("Writing response")
          }
          break
        }

        case "content_block_delta": {
          const d = event.delta
          if (!d) break

          if (d.type === "text_delta" && d.text) {
            if (currentBlock?.type === "text") {
              ;(currentBlock as TextBlock).text += d.text
            }
            fullText += d.text
            yield d.text
          } else if (d.type === "thinking_delta" && d.thinking) {
            if (currentBlock?.type === "thinking") {
              ;(currentBlock as ThinkingBlock).thinking += d.thinking
            }
            await onThinkingDelta?.(d.thinking)
          } else if (d.type === "signature_delta" && d.signature) {
            thinkingSig += d.signature
            if (currentBlock?.type === "thinking") {
              ;(currentBlock as ThinkingBlock).signature = thinkingSig
            }
          } else if (d.type === "input_json_delta" && d.partial_json != null) {
            toolJsonParts += d.partial_json
            // Throttled status update : every ~2KB of accumulated JSON or
            // every ~100ms, whichever fires first. Without throttling we'd
            // re-render the spinner line on every delta (potentially hundreds
            // per second for a fast tool block).
            const now = Date.now()
            const grewEnough = toolJsonParts.length - lastStatusBytes >= STATUS_THROTTLE_BYTES
            const elapsedEnough = now - lastStatusUpdateAt >= STATUS_THROTTLE_MS
            if (grewEnough || elapsedEnough) {
              lastStatusBytes = toolJsonParts.length
              lastStatusUpdateAt = now
              const hint = extractToolHint(activeToolName, toolJsonParts)
              const size = formatBytes(toolJsonParts.length)
              const label = hint
                ? `Calling ${activeToolName}: ${hint} (${size})`
                : `Calling ${activeToolName}: streaming input (${size})`
              requestStatus.update(label)
            }
          }
          break
        }

        case "content_block_stop": {
          if (currentBlock) {
            const stoppedThinking = currentBlock.type === "thinking"
            const stoppedText = currentBlock.type === "text"
            const stoppedToolUse = currentBlock.type === "tool_use"
            // Finalize tool_use: parse accumulated JSON into input
            if (currentBlock.type === "tool_use" && toolJsonParts) {
              try {
                ;(currentBlock as ToolUseBlock).input = JSON.parse(toolJsonParts)
              } catch {
                // partial JSON : keep what we have
                ;(currentBlock as ToolUseBlock).input = { _raw: toolJsonParts }
              }
            }
            blocks.push(currentBlock as ContentBlock)
            if (stoppedThinking) await onThinkingStop?.()
            // Fire onTextStop AFTER the block is pushed onto `blocks`, so
            // a handler that walks `blocks[]` sees the just-finished text
            // block. Symmetric with `onThinkingStop`. See the option's
            // doc-comment for why hosts care about this seam.
            if (stoppedText) await onTextStop?.()
            if (stoppedToolUse && activeToolName) {
              requestStatus.update(`Calling ${activeToolName}: dispatching`)
            }
          }
          currentBlock = null
          toolJsonParts = ""
          thinkingSig = ""
          activeToolName = ""
          break
        }

        case "message_delta": {
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason
          }
          break
        }
      }
    }

    return { blocks, text: fullText, stopReason }
  } finally {
    requestStatus.clear()
  }
}

// ---------------------------------------------------------------------------
// listModels : fetch available models for this user
// ---------------------------------------------------------------------------

/** Endpoint for listing available models. */
const MODELS_URL = "https://api.anthropic.com/v1/models?beta=true"

/**
 * List models available to the authenticated user, plus synthesized
 * `[1m]` context-window variants.
 *
 * Calls `GET /v1/models?beta=true` (matching the Anthropic SDK's `list()`
 * method) to fetch the real model list, then appends `[1m]`-suffixed copies
 * for any model that supports the 1M context window. The suffix is a
 * client-side convention : the API itself doesn't know about it. The
 * `--list-models` CLI flag uses this expanded list so users can pick
 * `claude-opus-4-7[1m]` from the menu and get 1M context automatically.
 *
 * @param auth Authenticated credentials
 * @param networkClient Network client used for the models request.
 * @returns Array of {@link ModelInfo}, with `[1m]` variants appended
 *
 * @see cc-03312026/src/utils/context.ts:modelSupports1M()
 */
export async function listModels(
  auth: AuthResult,
  networkClient: NetworkClient = defaultNetworkClient,
): Promise<ModelInfo[]> {
  const sessionId = getSessionId()
  const headers = buildHeaders(auth, sessionId)

  debugHeader(`GET ${MODELS_URL}`)

  const response = await networkClient.request({
    label: "models.list",
    method: "GET",
    url: MODELS_URL,
    headers,
  })

  debugResponse(response.status, response.headers)

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Models API ${response.status}: ${errorBody}`)
  }

  const data = await response.json<{ data: ModelInfo[] }>()
  const models = data.data

  // Synthesize 1M context variants for models that support it.
  // The CLI uses a client-side [1m] suffix convention : these aren't separate
  // API model IDs. The actual 1M activation happens via the context-1m-2025-08-07
  // beta flag. See cc-03312026/src/utils/context.ts:modelSupports1M().
  // Opus-4-7 and sonnet-4 both advertise 1M context via the context-1m beta.
  // (Older opus-4-6 also did, but it's gone from the live catalog as of 2.1.118.)
  const supports1M = (id: string) =>
    id.includes("claude-sonnet-4") || id.includes("opus-4-7") || id.includes("opus-4-6")

  const variants: ModelInfo[] = []
  for (const m of models) {
    if (supports1M(m.id)) {
      variants.push({
        ...m,
        id: `${m.id}[1m]`,
        display_name: m.display_name ? `${m.display_name} (1M context)` : `${m.id} (1M context)`,
      })
    }
  }

  return [...models, ...variants]
}

// ---------------------------------------------------------------------------
// sendMessageSync : convenience, collects full response
// ---------------------------------------------------------------------------

/**
 * Send a message and return the concatenated text as a single string.
 *
 * Convenience wrapper around {@link sendMessage} that consumes the entire
 * stream and returns just the text. Use this when you don't care about
 * structured blocks or live streaming : e.g. in tests, or for simple
 * one-shot prompts.
 *
 * @param opts - Same options as {@link sendMessage}
 * @returns Concatenated text from all `text_delta` events
 *
 * @example
 * ```ts
 * const reply = await sendMessageSync({ auth, messages: [...] });
 * console.log(reply);
 * ```
 */
export async function sendMessageSync(opts: SendOptions): Promise<string> {
  let result = ""
  const gen = sendMessage(opts)
  while (true) {
    const { done, value } = await gen.next()
    if (done) break
    result += value
  }
  return result
}

/**
 * Send a message and return the full {@link StreamedResponse} with all blocks.
 *
 * Convenience wrapper around {@link sendMessage} that drains the stream and
 * returns the structured response. Use this when you need access to thinking
 * blocks, tool_use blocks, or the stop reason : not just the text.
 *
 * @param opts - Same options as {@link sendMessage}
 * @returns Full structured response (blocks + text + stopReason)
 *
 * @example
 * ```ts
 * const result = await sendMessageFull({ auth, messages, tools: TOOL_DEFINITIONS });
 * if (result.stopReason === "tool_use") {
 *   const toolCalls = result.blocks.filter(b => b.type === "tool_use");
 *   // ... execute tools and continue
 * }
 * ```
 */
export async function sendMessageFull(opts: SendOptions): Promise<StreamedResponse> {
  const gen = sendMessage(opts)
  let lastReturn: StreamedResponse | undefined
  while (true) {
    const next = await gen.next()
    if (next.done) {
      lastReturn = next.value
      break
    }
  }
  return lastReturn ?? { blocks: [], text: "", stopReason: null }
}

// ---------------------------------------------------------------------------
// Quota check : cheap haiku request to verify account has quota
// ---------------------------------------------------------------------------

/**
 * Send a minimal quota-check request to verify the account has quota.
 *
 * Mirrors the real CLI's startup behavior (capture: fetch-002): a cheap
 * haiku request with `max_tokens: 1` and the literal string `"quota"` as
 * the user message. No system prompt, no tools, no thinking, no
 * output_config : just the bare minimum to round-trip the API and surface
 * a 429/auth error early before the user types anything.
 *
 * Uses the `"quota"` request type which sends only 5 beta flags (no
 * `claude-code-20250219`, no conversation-specific flags).
 *
 * **Catches all errors** and returns false on any failure (including
 * network errors). Use {@link sendMessage} directly if you need the actual
 * error message.
 *
 * @param auth Authenticated credentials
 * @param networkClient Network client used for the quota request.
 * @returns True if the request succeeded (200 OK), false on any error
 */
export type QuotaResult = { ok: false } | { ok: true; rateLimits: Map<string, string> }

/**
 * Probe the Anthropic API for the current quota / rate-limit state. Returns
 * `{ok: true, rateLimits}` on a 200 (with the parsed `anthropic-ratelimit-*`
 * headers), or `{ok: false}` on any error.
 */
export async function checkQuota(
  auth: AuthResult,
  networkClient: NetworkClient = defaultNetworkClient,
  signal?: AbortSignal,
): Promise<QuotaResult> {
  const sessionId = getSessionId()
  const headers = buildHeaders(auth, sessionId, "quota")
  const metadata = buildMetadata(auth)

  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1,
    messages: [{ role: "user", content: "quota" }],
    metadata,
  }

  debugHeader("POST (quota check)")
  debugKV("model", body.model)

  const serializedBody = JSON.stringify(body)
  const doRequest = async (token: string) => {
    const h = { ...headers }
    if (h.authorization) h.authorization = `Bearer ${token}`
    else if (h["x-api-key"]) h["x-api-key"] = token

    return networkClient.request({
      label: "quota.check",
      method: "POST",
      url: API_URL,
      headers: h,
      body: serializedBody,
      // Signal forwarded to the underlying transport (fetch / http2). The
      // live-area `quota-status` slot passes `ctx.abort`; if the
      // `LiveAreaScheduler.timeoutMs` elapses the request is canceled at
      // the network layer and `doRequest` rejects with `AbortError` :
      // freeing the slot's `inFlight` gate so the next heartbeat tick
      // (and any bus-driven `quota.headersReceived` re-fire) can run.
      // Without this, a probe stuck on a dead TCP socket (e.g. after
      // macOS sleep/wake) would deadlock both refresh paths permanently.
      signal,
    })
  }

  try {
    let response = await doRequest(auth.token)

    // 401 retry : same multi-process store-first mitigation as in
    // `sendMessage` above (see the long comment at the main 401 site).
    // checkQuota fires from the live-area `quota-status` plugin's
    // heartbeat AND on every `quota.headersReceived` event; with 100s of
    // agents, this path is one of the biggest contributors to refresh
    // contention if we don't deduplicate.
    if (response.status === 401 && auth.refresh) {
      let recovered = false
      try {
        const fresh = readCredentials()
        const freshToken = fresh?.claudeAiOauth?.accessToken
        if (freshToken && freshToken !== auth.token) {
          auth.token = freshToken
          response = await doRequest(freshToken)
          if (response.ok) recovered = true
        }
      } catch {
        // best-effort; fall through to refresh
      }
      if (!recovered && response.status === 401) {
        const refreshed = await auth.refresh()
        response = await doRequest(refreshed.token)
        auth.token = refreshed.token
      }
    }

    debugResponse(response.status, response.headers)

    if (!response.ok) {
      const errorBody = await response.text()
      if (isDebug()) {
        debugHeader(c.red(`Quota check failed: ${response.status}`))
        console.error(`  ${errorBody.slice(0, 200)}`)
      }
      return { ok: false }
    }

    // Same broadcast as the main completion path : cache + bus emit.
    // `checkQuota` is called both at startup (when the plugin is
    // disabled) and as the live-area slot's cold-cache fallback, so
    // populating the cache here closes the loop if a later request
    // arrives before any chat completion happens.
    const rateLimits = broadcastResponseRateLimits(response.headers)
    return { ok: true, rateLimits }
  } catch (e) {
    if (isDebug()) {
      console.error(`  quota check error: ${e instanceof Error ? e.message : String(e)}`)
    }
    return { ok: false }
  }
}

/**
 * Transport-facing option + response types the agent loop hands to its
 * injectable `sendFn`, plus the small model-id helpers the agent uses to
 * normalize a context-variant alias before resolving a model.
 *
 * These are provider-neutral: `SendOptions` carries auth, the conversation,
 * generation knobs, and streaming callbacks; `StreamedResponse` is the
 * assembled turn the transport returns. Every provider adapter consumes the
 * canonical request/event types underneath; this module is the agent-loop
 * surface the transport codec maps to/from.
 *
 * @module llm/transport/types
 */

import type { AuthResult } from "../../auth.ts"
import type { RequestType, SystemBlock } from "../../headers.ts"
import type { NetworkClient } from "../../network/index.ts"
import type { ContentBlock, Message } from "../messages.ts"

type MaybePromise<T> = T | Promise<T>

/**
 * Options for one streaming completion handed to the agent's transport
 * (`Agent.sendFn`).
 *
 * Most fields have sensible defaults. Override `requestType` for quota checks
 * or title generation, which use a reduced feature set.
 */
export interface SendOptions {
  /** Authenticated credentials. */
  auth: AuthResult
  /** Conversation history. Sent in full on every request. */
  messages: Message[]
  /** System prompt blocks. */
  system?: SystemBlock[]
  /** Model ID. */
  model?: string
  /**
   * Provider selected at boot, for scoped model resolution. When set, the
   * transport uses it to disambiguate model entries when two providers
   * register the same bare model ID (e.g. two gateways serving the same
   * upstream model). Optional.
   */
  selectedProviderId?: string
  /** Max output tokens. */
  maxTokens?: number
  /** Stream the response. Default: true. */
  stream?: boolean
  /**
   * Request type: controls the feature set and gating.
   * - `"conversation"` (default): full feature set.
   * - `"quota"`: minimal, no thinking/effort (cheap quota checks).
   * - `"title"`: structured-output, no thinking (title generation).
   */
  requestType?: RequestType
  /** Network client used for API transport. */
  networkClient?: NetworkClient
  /**
   * Adaptive thinking config. Pass `false` to disable.
   *
   * `display` controls visibility of streamed thinking deltas:
   * - `"summarized"`: the provider streams plaintext thinking deltas.
   * - `"omitted"`: only the opaque signature is returned (no plaintext
   *   deltas), for faster time-to-first-text-token. Some models default to
   *   this; the caller must explicitly request `"summarized"` to see
   *   reasoning on those models.
   */
  thinking?: { type: "adaptive"; display?: "summarized" | "omitted" } | false
  /**
   * Effort level and/or structured output format.
   * - `effort`: model computation budget.
   * - `format`: JSON schema for structured outputs.
   */
  outputConfig?: {
    effort?: string
    format?: { type: string; schema?: unknown }
  }
  /** Tool definitions sent in the request. */
  tools?: Array<{ name: string; description: string; input_schema: unknown }>
  /** Temperature. Default: not sent (provider uses its default). */
  temperature?: number
  /**
   * Speed mode. `"fast"` opts into a provider's premium dispatch tier where
   * supported. Capability-gated: ignored on models whose registry entry
   * doesn't declare `speedFast: true`. Default: omitted.
   */
  speed?: "normal" | "fast"
  /**
   * Context-management edits sent at the top level where the provider
   * supports them. Pass `null` to opt out, or omit for the provider default
   * on `requestType:"conversation"`.
   */
  contextManagement?: { edits: Array<{ type: string; keep?: string }> } | null
  /** Called when a native model thinking block starts. */
  onThinkingStart?: () => MaybePromise<void>
  /** Called for native model thinking chunks as they stream. */
  onThinkingDelta?: (text: string) => MaybePromise<void>
  /** Called when a native model thinking block stops. */
  onThinkingStop?: () => MaybePromise<void>
  /**
   * Called when a `text` content block stops streaming.
   *
   * **Why this exists**: the host's response formatter (e.g. `mdstream`) is
   * typically spawned ONCE per `Agent.run` and persists across all tool
   * rounds, but a single `run()` can produce multiple text blocks (one per
   * sub-turn: text → tool → text → tool → …). Without a per-text-block
   * boundary, the formatter's `partial` paragraph buffer accumulates every
   * text-block's chunks into one logical paragraph; at end-of-run it
   * re-renders the combined buffer, smashing two unrelated sentences
   * together with no separator. Hosts use `onTextStop` to commit the
   * per-block partial at the right moment: AFTER the just-streamed text,
   * BEFORE any tool_use block lands in scrollback. Fires AFTER the completed
   * text block has been pushed onto `blocks[]`, so observers can read the
   * just-finished block. Symmetric with {@link SendOptions.onThinkingStop}.
   */
  onTextStop?: () => MaybePromise<void>
  /**
   * Stream-idle watchdog: if the server stops sending events for this many
   * ms while the request is in-flight (no terminator received yet), the
   * attempt is aborted and the outer retry loop tries again.
   *
   * Defaults to `30_000` (30 seconds). Guards against a stream that streams
   * partial content then stops without a terminator. Set lower in tests for
   * fast deterministic coverage.
   */
  streamIdleTimeoutMs?: number

  /**
   * Absolute upper bound on a single attempt, in ms. Belt-and-suspenders
   * against pathological hangs the idle watchdog might miss (e.g. a stream
   * that keeps sending pings forever but no real content).
   *
   * Defaults to `30 * 60_000` (30 minutes). A model with adaptive thinking
   * on a hard prompt can legitimately think for many minutes; this cap is
   * generous to avoid false positives.
   */
  attemptHardTimeoutMs?: number

  /**
   * Upper bound, in ms, on the request-send + wait-for-response-headers
   * phase (everything BEFORE the first byte of the response body). The
   * idle watchdog only arms once we start reading the body, so without
   * this knob a stalled upload, or a server that accepts the POST but never
   * returns headers, hangs forever with nothing to abort it.
   *
   * Defaults to `120_000` (2 minutes). When this deadline trips, the
   * attempt is aborted and the outer retry loop tries again against a fresh
   * connection. Set lower in tests for fast deterministic coverage.
   */
  responseHeadersTimeoutMs?: number

  /**
   * Optional cancellation signal forwarded to the underlying network
   * transport. When the signal aborts mid-request the transport tears down
   * the stream and the iterator throws an `AbortError`. Used by the REPL's
   * Esc/Ctrl+C handling to cancel an in-flight turn.
   */
  signal?: AbortSignal
}

/**
 * Structured response the transport returns after streaming completes.
 *
 * Contains all parsed content blocks (thinking, tool_use, text) plus a
 * convenience `text` field with the concatenated text. Use `blocks` to feed
 * back into conversation history; use `text` for the prose.
 */
export interface StreamedResponse {
  /** All content blocks in the order they appeared in the stream. */
  blocks: ContentBlock[]
  /** Concatenated text from text blocks only: convenience accessor. */
  text: string
  /** Stop reason (e.g. `"end_turn"`, `"tool_use"`, `"max_tokens"`). */
  stopReason: string | null
  /**
   * Stop-reason categorization. Populated on `stopReason: "refusal"` (and
   * other categorized stops). `null` on normal end_turn/tool_use/max_tokens.
   * Opaque `type` string the host can route on, optional `message` for
   * display.
   */
  stopDetails?: { type: string; message?: string } | null
  /**
   * Billed token usage for THIS turn, as reported by the provider. Merged
   * from the stream's start (input + cache counters) and end (output) so
   * the caller can persist the turn's exact footprint to the session log.
   * Absent when the stream never reported usage (e.g. an aborted turn).
   *
   * Field names are the persisted accumulator shape; see
   * `src/session-usage.ts`.
   */
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

/**
 * A single raw streaming event, as a provider's stream parser sees it before
 * translation to canonical events. Kept as a loose shape for the assemblers
 * that still consume raw events directly.
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
 * Model information returned by a provider's list-models endpoint: the
 * models the authenticated principal can access.
 */
export interface ModelInfo {
  id: string
  display_name?: string
  type: string
  created_at?: string
}

/**
 * Strip a client-side context-variant suffix (`[1m]` / `[2m]`) from a model
 * ID. The suffix is a UI convention meaning "use the large-context variant
 * of this model"; the real model ID sent on the wire has no suffix (the
 * large-context window is activated by a capability flag instead). This
 * helper strips the suffix so model resolution sees a valid ID.
 *
 * @param model - Model ID, possibly with a `[1m]` / `[2m]` suffix.
 * @returns Model ID with the suffix removed.
 */
export function normalizeModelForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, "")
}

/**
 * Check whether a model string requests the large (`[1m]`) context window.
 * Case-insensitive. Used to decide whether to opt into the large-context
 * capability.
 *
 * @param model - Model ID to inspect.
 * @returns True if the model has a `[1m]` suffix.
 */
export function has1mContext(model: string): boolean {
  return /\[1m\]/i.test(model)
}

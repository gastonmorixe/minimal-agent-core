/**
 * Canonical request shape passed to every provider adapter.
 *
 * The caller (`Agent.run`, the REPL, tests) builds one of these and
 * hands it to {@link run} (`src/llm/run.ts`). The adapter validates
 * against the resolved model's `Capabilities` and translates to the
 * provider's wire format.
 *
 * Design choices:
 *
 * - Everything tunable is on this one object. There's no provider-side
 *   `SendOptions` you'd need to remember to pass through.
 * - `thinking` and `effort` are first-class fields, not vendor extras,
 *   because every modern reasoning model exposes them in some form.
 * - `vendor.*` is the escape hatch for last-mile provider-only knobs
 *   we don't want to canonicalize (Anthropic `taskBudget`, OpenAI
 *   `serviceTier`, etc).
 * - `signal`, `streamIdleTimeoutMs`, `attemptHardTimeoutMs` are
 *   provider-neutral and handled by the shared transport, not each
 *   adapter.
 *
 * @module llm/canonical-request
 */

import type { CanonicalBlock, CanonicalMessage } from "./canonical-messages.ts"
import type { CanonicalToolDefinition, ToolChoice } from "./canonical-tools.ts"
import type { EffortLevel } from "./capabilities.ts"

// ---------------------------------------------------------------------------
// Sub-shapes
// ---------------------------------------------------------------------------

/**
 * Sampling + generation config. Fields are only honored when the
 * model's capability table marks them accepted; otherwise the
 * adapter drops them and `validate()` reports a `CapabilityViolation`.
 */
export interface GenerationConfig {
  /** Hard cap on output tokens. Adapter clamps to `capabilities.maxOutputTokens`. */
  maxOutputTokens?: number
  /** Sampling temperature. 0..2 on OpenAI, 0..1 on Anthropic. */
  temperature?: number
  topP?: number
  topK?: number
  stop?: string[]
  seed?: number
}

/**
 * Thinking / reasoning configuration.
 *
 * - `mode:"off"`: disable thinking. On adaptive-only models (opus
 *   4.7/4.8) this still works : the adapter omits the field, the
 *   server runs without it, the model may write longer prose.
 * - `mode:"adaptive"`: opt into adaptive (`thinking:{type:"adaptive"}`).
 *   `display` controls visibility of streamed reasoning deltas.
 * - `mode:"extended"`: legacy explicit-budget path. Rejected on
 *   opus-4-7+ (capability gate).
 */
export type ThinkingConfig =
  | { mode: "off" }
  | { mode: "adaptive"; display?: "visible" | "summary" | "omitted" }
  | { mode: "extended"; budgetTokens: number; display?: "visible" | "summary" | "omitted" }

/**
 * Output-shape constraint. JSON-schema mode is the strongest;
 * `json_object` is the older Anthropic / OpenAI loose-JSON mode.
 */
export type OutputFormat =
  | { type: "json_schema"; schema: object; strict?: boolean; name?: string }
  | { type: "json_object" }
  | { type: "text" }

/**
 * Anthropic-only vendor knobs.
 *
 * - `taskBudget`: gates `task-budgets-2026-03-13`; the model sees the
 *   countdown and self-moderates (min 20_000).
 * - `contextManagement`: explicit override for the top-level
 *   `context_management.edits` field. Default for opus conversations
 *   is `clear_thinking_20251015 / keep:"all"`; pass `null` to opt out.
 * - `cacheDiagnostics`: enables `cache-diagnosis-2026-04-07` and the
 *   `diagnostics: {previous_message_id}` body field.
 * - `mirrorStainlessNulls`: when true, emit `temperature: null`,
 *   `top_p: null`, `top_k: null` on the wire (byte-for-byte match
 *   the live CLI). Default is to omit them.
 * - `betaOverrides`: caller-driven additions to `anthropic-beta`.
 *   Useful for one-off feature probes.
 */
export interface AnthropicVendorOpts {
  taskBudget?: { type: "tokens"; total: number }
  contextManagement?: { edits: Array<{ type: string; keep?: string }> } | null
  cacheDiagnostics?: boolean
  mirrorStainlessNulls?: boolean
  betaOverrides?: { add?: string[]; remove?: string[] }
}

/**
 * OpenAI-only vendor knobs spanning both Chat Completions and
 * Responses. Adapter routes by surface.
 */
export interface OpenAIVendorOpts {
  /** Chat + Responses. */
  parallelToolCalls?: boolean
  /** Chat + Responses. `"flex"` | `"default"` | `"priority"` (provider-dependent). */
  serviceTier?: string
  /** Chat: pre-fill speculative completion. */
  prediction?: { type: "content"; content: string }
  /** Responses: keep conversation server-side. */
  store?: boolean
  /** Responses: include extra fields in the stream (e.g. encrypted reasoning). */
  include?: string[]
  /** Chat + Responses: opaque user id for abuse tracking. */
  user?: string
}

/**
 * Metadata threaded to the provider's metadata field. Anthropic
 * serializes `{deviceId, accountUuid, sessionId}` into a JSON string
 * under `metadata.user_id`; OpenAI accepts a flat `metadata` map
 * (16 pairs, ≤512 chars values).
 */
export interface RequestMetadata {
  /** Stable per-account identifier (no PII; opaque hash). */
  accountId?: string
  /** Conversation id; replayed in every request in a session. */
  sessionId?: string
  /** Per-install device id; used for fleet-level rate-limit grouping. */
  deviceId?: string
  /** Per-user id surfaced to provider's abuse tooling. */
  userId?: string
  /** Free-form key/value annotations (small + stringly typed). */
  custom?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface CanonicalRequest {
  /** Registry id (e.g. `"claude-opus-4-8"`, `"gpt-5"`, `"claude-opus-4-8[1m]"`). */
  modelId: string

  /**
   * System prefix. Array of blocks so the caller can attach per-block
   * cache hints. The adapter renders to the provider's system field
   * (Anthropic `system: []`, OpenAI Chat first message, OpenAI
   * Responses `instructions:` string).
   */
  system?: CanonicalBlock[]

  /** Conversation. Mid-conversation `role:"system"` lives here. */
  messages: CanonicalMessage[]

  /** Function/tool definitions. Server-tool entries opt-in via `server`. */
  tools?: CanonicalToolDefinition[]
  toolChoice?: ToolChoice

  /**
   * OpenAI Responses-only: server-managed history pointer. When set,
   * `messages` should contain only the new turn (+ tool outputs).
   */
  previousResponseId?: string

  /** Sampling + max-tokens. */
  generation?: GenerationConfig

  thinking?: ThinkingConfig
  effort?: EffortLevel
  outputFormat?: OutputFormat

  /** Stream the response. Defaults to `true`. */
  stream?: boolean

  /**
   * Provider-specific premium tier (`speed:"fast"` on Anthropic).
   * Ignored on providers that don't support it (debug-logged once).
   */
  speed?: "normal" | "fast"

  /** Last-mile per-provider knobs. */
  vendor?: {
    anthropic?: AnthropicVendorOpts
    openai?: OpenAIVendorOpts
  }

  metadata?: RequestMetadata

  /** Provider-neutral cancellation. */
  signal?: AbortSignal

  /**
   * Stream-idle watchdog: if the server stops sending events for this
   * many ms, the attempt aborts and the outer retry loop tries again.
   */
  streamIdleTimeoutMs?: number

  /**
   * Hard ceiling on one attempt's wall-clock time. Catches pathological
   * "keeps sending pings forever" hangs the idle watchdog can't see.
   */
  attemptHardTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Concise summary returned by helpers (sync wrapper)
// ---------------------------------------------------------------------------

import type { CanonicalUsage, StopDetails, StopReason } from "./canonical-events.ts"

/**
 * Shape returned by `runOnce` / `runSync` for callers who don't want
 * to consume the streaming event union themselves. Mirrors the legacy
 * `StreamedResponse` so the carve-out in Phase 3 is a 1:1 shim.
 */
export interface CanonicalResponseSummary {
  /** Final accumulated content blocks in canonical form. */
  blocks: CanonicalBlock[]
  /** Concatenated text from text blocks only. */
  text: string
  stopReason: StopReason | null
  stopDetails?: StopDetails | null
  usage: CanonicalUsage
  /** Provider-specific extras (Anthropic context_management, etc.). */
  receipts?: Record<string, unknown>
}

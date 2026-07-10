/**
 * Capability flags describing what a specific (provider, surface, model)
 * tuple can do on the wire. The agent loop never asks "is this opus-4-8?"
 * directly : it asks "does this model support adaptive thinking, fast mode,
 * mid-conversation system messages, …?". The {@link Capabilities} record
 * is what the model registry stores per entry, and what
 * {@link ProviderAdapter.validate} uses to gate `CanonicalRequest`s before
 * they hit the wire.
 *
 * Capability is data, not branching. Don't reach for
 * `if (model.id === "claude-opus-4-8")` anywhere in the agent loop : if you need a new
 * decision point, add a new field here and tick the box on every
 * `ModelEntry` that supports it.
 *
 * The shapes are deliberately tight (booleans + small enums) so a model
 * registration reads as a flat table that's easy to diff when a new
 * model drops.
 *
 * @module llm/capabilities
 */

// ---------------------------------------------------------------------------
// Effort levels
// ---------------------------------------------------------------------------

/**
 * Provider/model-specific reasoning-effort token.
 *
 * This deliberately stays open instead of normalizing every provider's
 * vocabulary into a core enum. Providers declare the exact wire values each
 * model accepts, such as `"none"`, `"xhigh"`, `"max"`, or a vendor-specific
 * tier. Callers validate against that model's `capabilities.effort.levels`.
 */
export type EffortLevel = string

/**
 * Legacy known-level ordering for UIs that need a deterministic sort. It is
 * not a validation allow-list and does not constrain provider model tables.
 */
export const EFFORT_LEVELS: ReadonlyArray<EffortLevel> = ["low", "medium", "high", "xhigh", "max"]

// ---------------------------------------------------------------------------
// Sub-shapes
// ---------------------------------------------------------------------------

/**
 * Thinking / reasoning support shape.
 *
 * - `adaptive`: model picks per-turn whether to think (Anthropic
 *   `thinking:{type:"adaptive"}`, opus-4-6+; OpenAI reasoning models).
 * - `extended`: caller can pass an explicit budget
 *   (`thinking:{type:"enabled", budget_tokens}`, pre-opus-4-7 + sonnet-4-5
 *   and haiku-4-5; OpenAI: no analogue).
 * - `visible`: reasoning can be streamed back as text deltas
 *   (Anthropic `display:"summarized"`; OpenAI Responses
 *   `response.reasoning_summary_text.delta`).
 * - `interleaved`: think → text → think → text within one assistant turn.
 */
export interface ThinkingSupport {
  adaptive: boolean
  extended: boolean
  visible: boolean
  interleaved: boolean
}

/**
 * Effort param support. `levels` is the exact, model-specific set the server
 * accepts. `default` is what the adapter sends when the caller omits `effort`.
 */
export interface EffortSupport {
  levels: ReadonlyArray<EffortLevel>
  default: EffortLevel
}

/**
 * Prompt-caching shape.
 *
 * - `explicit`: caller can attach `cache_control` markers per-block
 *   (Anthropic only).
 * - `automatic`: provider caches the prefix without caller hints (OpenAI).
 * - `ttls`: TTL options the caller can request (Anthropic). Empty when
 *   automatic.
 * - `minPrefixTokens`: shortest cacheable prefix. Below this, caching
 *   silently doesn't trigger.
 * - `reportsCacheHits`: provider returns cache-read/write tokens in usage.
 */
export interface CachingSupport {
  explicit: boolean
  automatic: boolean
  ttls: ReadonlyArray<"5m" | "1h">
  minPrefixTokens: number
  reportsCacheHits: boolean
}

/**
 * Tool / function-calling support.
 *
 * `parallel` = the assistant can emit ≥ 2 `tool_use` blocks in one turn.
 * `fineGrainedStreaming` = server streams partial `arguments` / `input`
 * JSON before the call completes.
 * `strictSchema` = server validates inputs against the declared JSON
 * Schema (OpenAI `strict:true`; Anthropic does not).
 */
export interface ToolSupport {
  userDefined: boolean
  parallel: boolean
  fineGrainedStreaming: boolean
  toolChoice: boolean
  strictSchema: boolean
}

/**
 * Modality support (input + output, separate from textual content).
 */
export interface ModalitySupport {
  image: boolean
  audio: boolean
  pdf: boolean
  video: boolean
}

/**
 * Server-side tools the provider exposes natively (no host execution).
 * Each id is a stable canonical name; adapters translate to the wire
 * (e.g. `web_search_20250305` on Anthropic, `web_search_preview` on
 * OpenAI Responses).
 */
export type ServerToolId =
  | "web_search"
  | "code_interpreter"
  | "computer_use"
  | "file_search"
  | "advisor"

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Full capability record. Every field is required at registration time :
 * no implicit defaults. If a new feature lands and we add a field here,
 * the type system will force every existing model to declare its stance.
 *
 * Add new fields **at the end** to keep diffs small.
 */
export interface Capabilities {
  // -- Context --
  /** Max input tokens accepted on this model. */
  contextWindow: number
  /** Max output tokens per response (synchronous Messages API). */
  maxOutputTokens: number
  /**
   * True when the provider validates input + requested output against one
   * shared context window. When true, callers must clamp `maxOutputTokens`
   * to the room left after the request input.
   */
  outputTokensShareContextWindow: boolean
  /** Max output tokens via batch endpoints. `null` when no batch. */
  maxOutputTokensBatch: number | null

  // -- Reasoning --
  thinking: ThinkingSupport
  effort: EffortSupport

  // -- Sampling (only honored when capability is true) --
  acceptsTemperature: boolean
  acceptsTopP: boolean
  acceptsTopK: boolean
  acceptsSeed: boolean
  acceptsStopSequences: boolean

  // -- Speed mode --
  /** Provider-specific premium tier (`speed:"fast"` on Anthropic). */
  speedFast: boolean

  // -- Caching --
  caching: CachingSupport

  // -- Tools --
  tools: ToolSupport

  // -- System prompt --
  /**
   * Accepts `{role:"system"}` entries in the middle of `messages[]`
   * (not just the top-level `system` field). Anthropic: requires
   * `mid-conversation-system-2026-04-07` beta + opus-4-7+/sonnet-4-6.
   * OpenAI Chat/Responses: always true.
   */
  midConversationSystem: boolean

  // -- Output shaping --
  structuredOutputs: boolean
  /** Last assistant message can be a partial prefill the model continues. */
  assistantPrefill: boolean

  // -- Multimodal --
  modalities: ModalitySupport

  // -- Stateful conversation --
  /**
   * Provider keeps history server-side; caller sends only deltas with
   * a `previousResponseId` pointer (OpenAI Responses).
   */
  serverSideHistory: boolean

  // -- Server-hosted tools --
  serverTools: ReadonlyArray<ServerToolId>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tightly-defaulted blank capabilities. Useful for building a new
 * `ModelEntry` declaratively : start with `defaultCapabilities()` and
 * overwrite the fields the model actually supports.
 *
 * Pure-text, no caching, no tools, no thinking : the lowest common
 * denominator.
 */
export function defaultCapabilities(): Capabilities {
  return {
    contextWindow: 8_192,
    maxOutputTokens: 4_096,
    outputTokensShareContextWindow: false,
    maxOutputTokensBatch: null,
    thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
    effort: { levels: [], default: "medium" },
    acceptsTemperature: true,
    acceptsTopP: true,
    acceptsTopK: false,
    acceptsSeed: false,
    acceptsStopSequences: true,
    speedFast: false,
    caching: {
      explicit: false,
      automatic: false,
      ttls: [],
      minPrefixTokens: 0,
      reportsCacheHits: false,
    },
    tools: {
      userDefined: false,
      parallel: false,
      fineGrainedStreaming: false,
      toolChoice: false,
      strictSchema: false,
    },
    midConversationSystem: false,
    structuredOutputs: false,
    assistantPrefill: false,
    modalities: { image: false, audio: false, pdf: false, video: false },
    serverSideHistory: false,
    serverTools: [],
  }
}

/**
 * Compare two effort levels by the legacy known-level order. Unknown,
 * provider-specific values sort after known levels, then lexicographically.
 */
export function compareEffort(a: EffortLevel, b: EffortLevel): number {
  const ai = EFFORT_LEVELS.indexOf(a)
  const bi = EFFORT_LEVELS.indexOf(b)
  if (ai >= 0 && bi >= 0) return ai - bi
  if (ai >= 0) return -1
  if (bi >= 0) return 1
  return a.localeCompare(b)
}

/**
 * Is `level` among the supported set for this `EffortSupport` table?
 * Cheap and inlinable; written as a function so the call sites read
 * intent rather than `support.levels.includes(level)`.
 */
export function supportsEffort(support: EffortSupport, level: EffortLevel): boolean {
  return support.levels.includes(level)
}

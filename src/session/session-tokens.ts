/**
 * Session-scoped accumulator of Anthropic `usage` token counts.
 *
 * Every successful API call yields a `message_start` event whose
 * `usage` payload reports input/output/cache tokens for that turn.
 * `client.ts` calls {@link addSessionUsage} alongside the existing
 * cache-anomaly observer. The `quota-status` plugin reads
 * {@link getSessionTokens} to render "tokens this session" in the
 * sticky-bottom footer.
 *
 * Module-level singleton, scoped to the agent process. Tests
 * `clearSessionTokens()` between cases to prevent state leak.
 *
 * @module session-tokens
 */

import { findModel, findModelForProvider } from "../llm/model-registry.ts"
import type { CacheUsage } from "../quota/cache-usage.ts"

function shouldIncludeOutputInContextSize(): boolean {
  const modelId = (process.env.MINIMAL_AGENT_MODEL ?? "").replace(/\[(1|2)m\]/gi, "")
  const providerId = process.env.MINIMAL_AGENT_PROVIDER || undefined
  if (!modelId) return false
  const entry = providerId
    ? (findModelForProvider(modelId, providerId) ?? findModel(modelId))
    : findModel(modelId)
  return entry?.capabilities.outputTokensShareContextWindow === true
}

export interface SessionTokens {
  /** New input tokens (not served from cache). Cumulative across turns. */
  input: number
  /** Output (generated) tokens. Cumulative across turns. */
  output: number
  /**
   * Cumulative `cache_read_input_tokens` across all turns.
   *
   * ⚠️ Inherently inflated as a "session footprint" number. Anthropic's
   * cache hits re-serve the SAME cached prefix on every subsequent turn,
   * so summing per-turn `cache_read` ≈ ∫ context_size dt, not "how much
   * cached content exists." Useful for debug / anomaly detection only;
   * for any user-facing display, prefer {@link contextSize}.
   */
  cacheRead: number
  /** Input tokens written to cache (expensive once, then read cheaply). Cumulative. */
  cacheCreate: number
  /**
   * Sum of all four cumulative fields.
   *
   * ⚠️ Inherits the inflation from {@link cacheRead}. Kept for backwards
   * compatibility / debug — do NOT use as a user-facing "tokens this
   * session" number. Use {@link contextSize} instead.
   */
  total: number
  /** Number of API responses contributing to these totals. */
  turns: number
  /**
   * Latest turn's footprint in the model's context window. For
   * Anthropic-style models (`outputTokensShareContextWindow: false`) this
   * is `input + cacheRead + cacheCreate` (prefill size). For OpenAI-style
   * models that share the window it also includes `output` so the bar
   * reflects `prompt_tokens + completion_tokens` as a single budget.
   *
   * Replace-not-accumulate semantics — overwritten on every
   * {@link addSessionUsage} / {@link addSessionEstimatedUsage} call.
   * The `quota-status` footer renders `contextSize / contextWindow`.
   */
  contextSize: number
  /**
   * True when {@link contextSize} was derived from an estimate rather
   * than billed provider `usage` (provider omitted `usage`, offline
   * transcript fallback). Renderers may show a `~` marker.
   */
  contextSizeEstimated: boolean
}

let totals: SessionTokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  total: 0,
  turns: 0,
  contextSize: 0,
  contextSizeEstimated: false,
}

/** Fold a per-turn `usage` payload into the session totals. No-op on `undefined`. */
export function addSessionUsage(u: CacheUsage | undefined): void {
  if (!u) return
  const i = u.input_tokens ?? 0
  const o = u.output_tokens ?? 0
  const cr = u.cache_read_input_tokens ?? 0
  const cc = u.cache_creation_input_tokens ?? 0
  totals.input += i
  totals.output += o
  totals.cacheRead += cr
  totals.cacheCreate += cc
  totals.total += i + o + cr + cc
  totals.turns += 1
  // Replace-not-accumulate: this is the LATEST turn's footprint.
  // Anthropic-style models count only the input side (prefill);
  // OpenAI-style models share the window with output, so we include it.
  const includeOutput = shouldIncludeOutputInContextSize()
  totals.contextSize = includeOutput ? i + cr + cc + o : i + cr + cc
  totals.contextSizeEstimated = false
}

/**
 * Record an estimated turn when the provider omitted `usage` (ollama,
 * cursor, generic gateways). Keeps the live context bar from staying
 * at 0% while the transcript grows.
 *
 * `estimatedTokens` should already be scoped to the active model
 * (via `estimateTokensForModel` / provider `estimateTokens`).
 */
export function addSessionEstimatedUsage(estimatedTokens: number): void {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return
  const n = Math.ceil(estimatedTokens)
  totals.total += n
  totals.turns += 1
  totals.contextSize = n
  totals.contextSizeEstimated = true
}

/** Snapshot of the session-wide token totals (a defensive copy, safe to mutate). */
export function getSessionTokens(): SessionTokens {
  return { ...totals }
}

/**
 * Resets every counter to zero. Called when a new session starts (or a resume
 * re-seeds usage) so totals never leak across sessions.
 */
export function clearSessionTokens(): void {
  totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    total: 0,
    turns: 0,
    contextSize: 0,
    contextSizeEstimated: false,
  }
}

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

import type { CacheUsage } from "./cache.ts"

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
   * Latest turn's input footprint: `input_tokens + cache_read + cache_create`. Approximates "size of the conversation currently in
   * the model's context window."
   *
   * Replace-not-accumulate semantics — overwritten on every
   * {@link addSessionUsage} call, never summed. This is what the
   * `quota-status` footer's `✦ <N> ctx` segment displays.
   *
   * Does NOT include the latest turn's `output_tokens`. Output is
   * unknown at `message_start` (where we observe usage) since
   * generation hasn't happened yet, and including it would require
   * tracking a second update at `message_stop`. The input portion is
   * the dominant term for any non-trivial conversation.
   */
  contextSize: number
}

let totals: SessionTokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  total: 0,
  turns: 0,
  contextSize: 0,
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
  // Replace-not-accumulate: this is the LATEST turn's input footprint,
  // which equals (approximately) what's currently sitting in the
  // model's context window. Summing across turns would double-count
  // the cached prefix on every turn (see {@link cacheRead} docstring).
  totals.contextSize = i + cr + cc
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
  }
}

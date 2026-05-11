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
  /** New input tokens (not served from cache). */
  input: number
  /** Output (generated) tokens. */
  output: number
  /** Input tokens served from cache (cheap). */
  cacheRead: number
  /** Input tokens written to cache (expensive once, then read cheaply). */
  cacheCreate: number
  /** Sum of all four — single number for at-a-glance display. */
  total: number
  /** Number of API responses contributing to these totals. */
  turns: number
}

let totals: SessionTokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  total: 0,
  turns: 0,
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
}

export function getSessionTokens(): SessionTokens {
  return { ...totals }
}

export function clearSessionTokens(): void {
  totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, turns: 0 }
}

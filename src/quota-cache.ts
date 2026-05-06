/**
 * In-memory cache of the most recently observed
 * `anthropic-ratelimit-*` headers.
 *
 * The cache is written by every successful response in `client.ts`
 * (real chat completions, streaming completions, and the dedicated
 * `checkQuota` probe) and read by the `quota-status` plugin's
 * live-area slot handler. Pairing a write-on-response with a
 * cache-first read makes the live-area row update **immediately**
 * after every API call — no separate round-trip, no 5-minute lag.
 *
 * Module-level singleton, scoped to the agent process. Tests
 * `clearLastRateLimits()` between cases to prevent state leak.
 *
 * @module quota-cache
 */

/**
 * One cache entry. `at` is `Date.now()` at the moment the entry was
 * captured — useful for staleness gating in the plugin handler
 * (cache-fresh = use cache; cache-stale = re-probe).
 */
export interface CachedRateLimits {
  rateLimits: ReadonlyMap<string, string>
  at: number
}

let cache: { rateLimits: Map<string, string>; at: number } | null = null

/**
 * Replace the cache with a fresh snapshot. Empty maps are silently
 * ignored — they happen with test fakes / non-200 responses, and
 * blanking the cache there would cause the plugin to fall back to a
 * `checkQuota` probe unnecessarily.
 *
 * The input map is **copied** so the caller can mutate it freely.
 */
export function setLastRateLimits(rl: ReadonlyMap<string, string>): void {
  if (rl.size === 0) return
  const copy = new Map<string, string>()
  for (const [k, v] of rl) copy.set(k, v)
  cache = { rateLimits: copy, at: Date.now() }
}

/**
 * Read the latest snapshot, or `null` if nothing has been cached this
 * session. The returned map is the same instance held in the cache —
 * **do not mutate it**; treat it as immutable.
 */
export function getLastRateLimits(): CachedRateLimits | null {
  return cache
}

/**
 * Reset the cache. Tests call this in `beforeEach` so per-test fixtures
 * don't leak across cases. Production code never needs it.
 */
export function clearLastRateLimits(): void {
  cache = null
}

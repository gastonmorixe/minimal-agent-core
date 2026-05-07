/**
 * Helper that extracts `anthropic-ratelimit-*` headers from a fetch
 * `Response` and pushes them onto BOTH:
 *
 * 1. The in-process {@link setLastRateLimits} cache, so the
 *    `quota-status` plugin's slot handler can read them
 *    synchronously without paying another round-trip.
 *
 * 2. The plugin event bus (via {@link getGlobalEventBus}) on
 *    channel `"quota.headersReceived"`, so subscribed plugins —
 *    most notably the live-area scheduler's `refreshOn` listener —
 *    can react event-driven instead of waiting for the next
 *    timer tick.
 *
 * Wired into every `client.ts` response path that observes a 200
 * with rate-limit headers (real chat completions, the dedicated
 * `checkQuota` probe, future endpoints). Empty maps are silently
 * dropped — no cache write, no bus emit — so test fakes / non-200
 * paths don't trigger spurious "fresh quota" notifications.
 *
 * @module quota-broadcast
 */

import { getGlobalEventBus } from "./global-bus.ts"
import { setLastRateLimits } from "./quota-cache.ts"

/**
 * Channel name. Stable wire format — once published, plugins may
 * subscribe via `liveAreaSlots[].refreshOn` or a manifest `events[]`
 * entry, so renaming is a breaking change.
 */
export const QUOTA_HEADERS_RECEIVED = "quota.headersReceived"

/**
 * Payload shape for {@link QUOTA_HEADERS_RECEIVED}.
 *
 * The map is the same object cached by {@link setLastRateLimits} —
 * subscribers MUST treat it as read-only.
 */
export interface QuotaHeadersReceivedPayload {
  rateLimits: ReadonlyMap<string, string>
}

/**
 * Walk the response headers, copy every `anthropic-ratelimit-*`
 * entry into a new `Map`, and broadcast it to the cache + bus.
 *
 * Returns the extracted map (always — the caller often wants it for
 * its own bookkeeping; e.g. `checkQuota` returns it to the user as
 * the success payload). Returns an empty map when the response
 * carried no matching headers.
 *
 * Header names are not lowercased: real responses already arrive
 * lowercased and `formatQuotaSummary` matches both forms via regex.
 * We preserve the wire form for parity with prior behavior.
 */
export function broadcastResponseRateLimits(responseHeaders: Headers): Map<string, string> {
  const rl = new Map<string, string>()
  responseHeaders.forEach((v, k) => {
    if (k.startsWith("anthropic-ratelimit-")) rl.set(k, v)
  })
  if (rl.size === 0) return rl

  // Cache write is unconditional on a non-empty map. The bus emit is
  // optional-chained because it can race startup: a request that
  // resolves before `setGlobalEventBus(loader.bus())` lands in
  // index.ts has nothing to broadcast to. The cache still gets
  // populated in that case — the next `checkQuota` (or just the
  // first listener post-load) picks it up.
  setLastRateLimits(rl)
  const payload: QuotaHeadersReceivedPayload = { rateLimits: rl }
  getGlobalEventBus()?.emit(QUOTA_HEADERS_RECEIVED, payload)
  return rl
}

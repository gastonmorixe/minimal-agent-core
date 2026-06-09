/**
 * Helper that extracts rate-limit-shaped headers (any `*ratelimit*` name) from a fetch
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
import { getLastRateLimits, setLastRateLimits } from "./quota-cache.ts"

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
 * Rate-limit header NAME pattern, provider-agnostic: any header whose name
 * contains "ratelimit" (vendors ship `<vendor>-ratelimit-*`,
 * `x-ratelimit-*`, `ratelimit-*` per the IETF draft). Core only DETECTS
 * and caches these raw entries; interpreting them (window shapes, fields)
 * is the owning provider plugin's job behind the session-info seam, which
 * simply ignores names it doesn't understand.
 */
const RATELIMIT_HEADER_RE = /ratelimit/i

/**
 * Walk the response headers, copy every rate-limit-shaped entry into a
 * new `Map`, and broadcast it to the cache + bus.
 *
 * Returns the extracted map (always — the caller often wants it for
 * its own bookkeeping; e.g. `checkQuota` returns it to the user as
 * the success payload). Returns an empty map when the response
 * carried no matching headers.
 *
 * Header names are not lowercased: real responses already arrive
 * lowercased, and the plugin parsers match their own exact shapes.
 * We preserve the wire form for parity with prior behavior.
 */
export function broadcastResponseRateLimits(responseHeaders: Headers): Map<string, string> {
  const rl = new Map<string, string>()
  responseHeaders.forEach((v, k) => {
    if (RATELIMIT_HEADER_RE.test(k)) rl.set(k, v)
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

/**
 * Re-emit {@link QUOTA_HEADERS_RECEIVED} using the already-cached
 * rate-limits, without touching the cache.
 *
 * Why this exists: in the streaming chat path, response headers arrive
 * (and {@link broadcastResponseRateLimits} fires) BEFORE the SSE
 * `message_start` event delivers the `usage` payload that feeds the
 * session-tokens accumulator. The first broadcast therefore lets the
 * `quota-status` footer re-render with the new rate-limits but with
 * stale (prior-turn) session totals — visible to the user as the
 * `✦ <N> tok` segment always lagging one turn behind.
 *
 * `client.ts` calls this helper from inside the `message_start` SSE
 * case, right after `addSessionUsage(usage)`, so the scheduler re-fires
 * the slot a second time with fresh totals. The bus emit is a no-op
 * when the cache is empty (test harnesses, pre-first-response).
 */
export function rebroadcastQuotaForSessionUpdate(): void {
  const snap = getLastRateLimits()
  if (!snap || snap.rateLimits.size === 0) return
  const payload: QuotaHeadersReceivedPayload = { rateLimits: snap.rateLimits }
  getGlobalEventBus()?.emit(QUOTA_HEADERS_RECEIVED, payload)
}

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

import { getGlobalEventBus } from "../bus/global-bus.ts"

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

/**
 * Emit {@link QUOTA_HEADERS_RECEIVED} unconditionally, with an EMPTY payload,
 * to poke the footer into re-rendering after a turn completes.
 *
 * Why this exists: post-Wave-G every provider plugin lives in a sibling repo and
 * keeps its OWN rate-limit cache (`setAnthropicRateLimits` / `setOpenAIRateLimits`
 * on the adapter's `run()` path), which core cannot reach. The old in-tree
 * providers imported {@link broadcastResponseRateLimits} / {@link announceQuotaRefresh}
 * from here, so a fresh response both filled the core cache AND emitted the
 * refresh event. After the move, core's cache stays empty forever, so
 * {@link rebroadcastQuotaForSessionUpdate} (gated on a non-empty core cache) is a
 * permanent no-op and the `quota-status` footer only repaints on its 5-minute
 * heartbeat — the 5h/7d windows "vanish" for minutes at a time.
 *
 * The `quota-status` slot handler IGNORES the event payload: on any
 * `quota.headersReceived` it simply re-fires and re-reads the active provider's
 * OWN cache via `fetchSessionInfo`. So the host doesn't need the provider's
 * headers to trigger a repaint — it only needs to emit the event once the
 * provider has cached them. The canonical transport calls this after each
 * completed send, restoring same-turn footer refresh for EVERY provider without
 * importing any provider's cache.
 *
 * No-op when the bus isn't installed yet (pre-load, tests).
 */
export function signalQuotaRefresh(): void {
  const payload: QuotaHeadersReceivedPayload = { rateLimits: new Map() }
  getGlobalEventBus()?.emit(QUOTA_HEADERS_RECEIVED, payload)
}

/**
 * Emit {@link QUOTA_HEADERS_RECEIVED} WITHOUT touching the core
 * (`quota-cache.ts`) cache — the announce-only counterpart to
 * {@link broadcastResponseRateLimits}.
 *
 * Why this exists: {@link broadcastResponseRateLimits} both writes the core
 * Anthropic cache AND emits the bus event. A provider that keeps its OWN cache
 * (OpenAI's `x-codex-*` / `x-ratelimit-*` snapshot lives in
 * `plugins/llm-openai/session-info.ts`, not the core cache) still needs the
 * footer to repaint immediately on each turn. Without an emit the `quota-status`
 * slot only refreshes on its 5-minute heartbeat, so a fresh OpenAI/Codex session
 * shows `0%` until the timer ticks — exactly the "not fixed" symptom.
 *
 * The payload mirrors the cache-coupled path so existing listeners are
 * shape-compatible, but for these providers the listener just re-fires the slot
 * (which reads the provider's own cache via `fetchSessionInfo`), so only the
 * emit matters. No-op (and harmless) when the bus isn't installed yet.
 *
 * @param rl - The rate-limit map the caller just cached (for payload parity).
 */
export function announceQuotaRefresh(rl: ReadonlyMap<string, string>): void {
  if (rl.size === 0) return
  const payload: QuotaHeadersReceivedPayload = { rateLimits: rl }
  getGlobalEventBus()?.emit(QUOTA_HEADERS_RECEIVED, payload)
}

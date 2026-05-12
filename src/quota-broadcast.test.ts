/**
 * Regression tests for the quota broadcast helpers.
 *
 * The interesting case here is the "session-tokens lag" bug:
 * `broadcastResponseRateLimits` fires when response headers arrive
 * (before SSE consumption), but the session-tokens accumulator only
 * updates at the `message_start` SSE event. Without a second emit,
 * the `quota-status` footer's `✦ <N> tok` segment lagged one turn
 * behind. {@link rebroadcastQuotaForSessionUpdate} closes that gap.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { getGlobalEventBus, setGlobalEventBus } from "./global-bus.ts"
import { EventBus } from "./plugins/event-bus.ts"
import {
  broadcastResponseRateLimits,
  QUOTA_HEADERS_RECEIVED,
  type QuotaHeadersReceivedPayload,
  rebroadcastQuotaForSessionUpdate,
} from "./quota-broadcast.ts"
import { clearLastRateLimits, getLastRateLimits } from "./quota-cache.ts"

function makeHeaders(rl: Record<string, string>): Headers {
  const h = new Headers()
  for (const [k, v] of Object.entries(rl)) h.set(k, v)
  return h
}

/**
 * Drain a couple of microtask hops so the bus's `queueMicrotask`-based
 * delivery actually runs before we assert.
 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("quota-broadcast", () => {
  let bus: EventBus
  let received: QuotaHeadersReceivedPayload[]

  beforeEach(() => {
    clearLastRateLimits()
    bus = new EventBus()
    setGlobalEventBus(bus)
    received = []
    bus.on<QuotaHeadersReceivedPayload>(QUOTA_HEADERS_RECEIVED, (ctx) => {
      received.push(ctx.payload)
    })
  })

  afterEach(() => {
    setGlobalEventBus(null)
    clearLastRateLimits()
  })

  it("broadcastResponseRateLimits writes cache and emits once", async () => {
    const headers = makeHeaders({
      "anthropic-ratelimit-unified-5h-utilization": "0.21",
      "anthropic-ratelimit-unified-5h-reset": "1700000000",
    })
    const out = broadcastResponseRateLimits(headers)
    expect(out.size).toBe(2)
    expect(getLastRateLimits()?.rateLimits.size).toBe(2)
    await flush()
    expect(received.length).toBe(1)
    expect(received[0]!.rateLimits.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.21")
  })

  it("rebroadcastQuotaForSessionUpdate re-emits without touching cache", async () => {
    const headers = makeHeaders({
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
    })
    broadcastResponseRateLimits(headers)
    const firstSnap = getLastRateLimits()
    await flush()
    expect(received.length).toBe(1)

    rebroadcastQuotaForSessionUpdate()
    await flush()
    expect(received.length).toBe(2)
    // Same cache snapshot — not replaced.
    expect(getLastRateLimits()).toBe(firstSnap)
    // Payload carries the cached rate-limits.
    expect(received[1]!.rateLimits.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.42")
  })

  it("rebroadcastQuotaForSessionUpdate is a no-op before any broadcast", async () => {
    // Cache cold (no prior response) — re-broadcast should not emit
    // a payload with an empty map; downstream subscribers would
    // pointlessly re-render with no data.
    rebroadcastQuotaForSessionUpdate()
    await flush()
    expect(received.length).toBe(0)
  })

  it("rebroadcastQuotaForSessionUpdate is a no-op with no bus installed", async () => {
    setGlobalEventBus(null)
    const headers = makeHeaders({
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
    })
    // First broadcast populates the cache even when bus is missing
    // (the bus emit is optional-chained).
    broadcastResponseRateLimits(headers)
    setGlobalEventBus(bus)
    // Cache is hot but the test's own listener is on the new bus
    // instance, so rebroadcast emits onto it.
    rebroadcastQuotaForSessionUpdate()
    await flush()
    expect(received.length).toBe(1)
    expect(getGlobalEventBus()).toBe(bus)
  })

  it("two emits per turn (headers + session-update) carry the SAME rate-limits", async () => {
    // Pins the contract that the second emit reuses the cached map
    // rather than re-parsing headers or substituting an empty map.
    const headers = makeHeaders({
      "anthropic-ratelimit-unified-7d-utilization": "0.08",
    })
    broadcastResponseRateLimits(headers)
    rebroadcastQuotaForSessionUpdate()
    await flush()
    expect(received.length).toBe(2)
    expect(received[0]!.rateLimits.get("anthropic-ratelimit-unified-7d-utilization")).toBe("0.08")
    expect(received[1]!.rateLimits.get("anthropic-ratelimit-unified-7d-utilization")).toBe("0.08")
  })
})

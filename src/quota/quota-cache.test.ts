/**
 * Unit tests for the rate-limit cache.
 *
 * Module-level singleton state: every test starts with a
 * `clearLastRateLimits()` so prior cases don't leak forward.
 */

import { beforeEach, describe, expect, it } from "bun:test"

import { clearLastRateLimits, getLastRateLimits, setLastRateLimits } from "./quota-cache.ts"

describe("quota-cache", () => {
  beforeEach(() => {
    clearLastRateLimits()
  })

  it("starts empty", () => {
    expect(getLastRateLimits()).toBeNull()
  })

  it("round-trips a populated map and stamps the time", () => {
    const before = Date.now()
    setLastRateLimits(new Map([["acme-ratelimit-unified-5h-utilization", "0.42"]]))
    const after = Date.now()
    const got = getLastRateLimits()
    expect(got).not.toBeNull()
    expect(got!.rateLimits.get("acme-ratelimit-unified-5h-utilization")).toBe("0.42")
    expect(got!.at).toBeGreaterThanOrEqual(before)
    expect(got!.at).toBeLessThanOrEqual(after)
  })

  it("ignores empty input maps (test fakes / non-200 paths)", () => {
    setLastRateLimits(new Map([["acme-ratelimit-unified-5h-utilization", "0.10"]]))
    const before = getLastRateLimits()
    setLastRateLimits(new Map()) // no-op
    const after = getLastRateLimits()
    expect(after).toBe(before) // identity preserved
  })

  it("subsequent writes replace the snapshot wholesale (newer wins)", () => {
    setLastRateLimits(new Map([["acme-ratelimit-unified-5h-utilization", "0.10"]]))
    const old = getLastRateLimits()!
    // Force a tiny gap so `at` advances at least one ms on most clocks.
    const t0 = Date.now()
    while (Date.now() === t0) {
      /* spin */
    }
    setLastRateLimits(new Map([["acme-ratelimit-unified-5h-utilization", "0.99"]]))
    const fresh = getLastRateLimits()!
    expect(fresh.rateLimits.get("acme-ratelimit-unified-5h-utilization")).toBe("0.99")
    expect(fresh.at).toBeGreaterThan(old.at)
  })

  it("cached map is a copy — caller mutations don't affect the snapshot", () => {
    const src = new Map([["acme-ratelimit-unified-5h-utilization", "0.10"]])
    setLastRateLimits(src)
    src.set("acme-ratelimit-unified-5h-utilization", "0.99")
    src.set("extra", "junk")
    const got = getLastRateLimits()!
    expect(got.rateLimits.get("acme-ratelimit-unified-5h-utilization")).toBe("0.10")
    expect(got.rateLimits.has("extra")).toBe(false)
  })

  it("clearLastRateLimits resets to null", () => {
    setLastRateLimits(new Map([["k", "v"]]))
    expect(getLastRateLimits()).not.toBeNull()
    clearLastRateLimits()
    expect(getLastRateLimits()).toBeNull()
  })
})

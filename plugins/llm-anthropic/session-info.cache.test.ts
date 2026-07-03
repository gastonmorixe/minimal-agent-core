/**
 * Anthropic `fetchAnthropicSessionInfo` cache-only contract +
 * `primeAnthropicSessionInfo` in-flight dedupe.
 *
 * These are the two halves of the post-2026-05-30 refactor that moved the
 * cold-start network probe OUT of `fetch` (cache-only, non-blocking, called
 * by the status-bar slot every tick) and INTO `prime` (fire-and-forget, owns
 * the bounded `checkQuota` call). The split kills the slot-timeout warning
 * observed at boot: the slot's per-tick `timeoutMs` (8s, designed to detect
 * stuck handlers) was tripping on a cold checkQuota POST that legitimately
 * needed 5–15s on a cold TCP/TLS handshake.
 *
 * @module llm/providers/anthropic/session-info.cache.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import {
  clearLastRateLimits,
  getLastRateLimits,
  setLastRateLimits,
} from "../../src/quota/quota-cache.ts"

import {
  _resetAnthropicPrimeInFlight,
  fetchAnthropicSessionInfo,
  primeAnthropicSessionInfo,
} from "./session-info.ts"

afterEach(() => {
  clearLastRateLimits()
  _resetAnthropicPrimeInFlight()
})

// ---------------------------------------------------------------------------
// fetchAnthropicSessionInfo : cache-only
// ---------------------------------------------------------------------------

describe("fetchAnthropicSessionInfo (cache-only)", () => {
  it("returns context + label with no quota when the cache is cold", async () => {
    // Sanity: no cache populated.
    const info = await fetchAnthropicSessionInfo({ modelId: "claude-opus-4-8" })
    expect(info).not.toBeNull()
    expect(info!.modelLabel).toBeDefined() // computed locally, no network
    expect(info!.quota).toBeUndefined()
  })

  it("returns parsed quota windows when the cache has fresh headers", async () => {
    setLastRateLimits(
      new Map<string, string>([
        ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
        ["anthropic-ratelimit-unified-7d-utilization", "0.08"],
      ]),
    )
    const info = await fetchAnthropicSessionInfo({ modelId: "claude-opus-4-8" })
    expect(info!.quota?.windows.map((w) => w.id)).toEqual(["5h", "7d"])
    expect(info!.quota?.windows[0]?.utilization).toBeCloseTo(0.21)
  })

  it("surfaces overage even when no quota windows are present", async () => {
    setLastRateLimits(
      new Map<string, string>([["anthropic-ratelimit-unified-overage-status", "allowed"]]),
    )
    const info = await fetchAnthropicSessionInfo({ modelId: "claude-opus-4-8" })
    expect(info!.quota?.overage).toEqual({ active: true })
    expect(info!.quota?.windows).toEqual([])
  })

  it("keeps rendering stale windows AND kicks a background re-probe", async () => {
    // Regression: the "quota disappears after a few idle minutes" bug. Once the
    // cold-start prime headers aged past FRESHNESS_MS, the next heartbeat/resize
    // tick used to read the cache as `null` and DROP the 5h/7d windows, with
    // nothing to refresh them until the user's next API turn. The fix renders
    // the last-known windows on a stale cache AND fires a bounded re-probe.
    setLastRateLimits(
      new Map<string, string>([
        ["anthropic-ratelimit-unified-5h-utilization", "0.64"],
        ["anthropic-ratelimit-unified-7d-utilization", "0.16"],
      ]),
    )

    // Age the cache past the freshness window by advancing the clock the
    // fetch path reads (`Date.now`). The cache's `at` was stamped at the real
    // now; +61s makes it stale without a real wait.
    const realNow = Date.now
    Date.now = () => realNow() + 61_000

    const prevTestAuth = process.env.MINIMAL_AGENT_TEST_AUTH
    process.env.MINIMAL_AGENT_TEST_AUTH = "1" // getAuth() → synthetic oauth (test env)
    let probed = false
    try {
      const networkClient = {
        request: async () => {
          probed = true
          return new Response("{}", {
            status: 200,
            headers: { "anthropic-ratelimit-unified-5h-utilization": "0.65" },
          })
        },
      }
      const info = await fetchAnthropicSessionInfo({
        modelId: "claude-opus-4-8",
        networkClient,
      })
      // Stale-but-present: the windows still render (not blanked).
      expect(info!.quota?.windows.map((w) => w.id)).toEqual(["5h", "7d"])
      expect(info!.quota?.windows[0]?.utilization).toBeCloseTo(0.64)
      // Let the fire-and-forget prime probe settle.
      await new Promise((r) => setTimeout(r, 0))
      expect(probed).toBe(true)
    } finally {
      Date.now = realNow
      if (prevTestAuth === undefined) delete process.env.MINIMAL_AGENT_TEST_AUTH
      else process.env.MINIMAL_AGENT_TEST_AUTH = prevTestAuth
    }
  })

  it("does NOT block on an aborted signal — cache-only, no I/O to cancel", async () => {
    // Pre-aborted signal: the cache-only fetch must resolve, not throw, because
    // there is no in-flight I/O to honor the cancellation.
    const ac = new AbortController()
    ac.abort()
    const info = await fetchAnthropicSessionInfo({
      modelId: "claude-opus-4-8",
      signal: ac.signal,
    })
    expect(info).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// primeAnthropicSessionInfo : dedupe + cache-fresh skip
// ---------------------------------------------------------------------------

describe("primeAnthropicSessionInfo", () => {
  it("no-ops without touching the network when the cache is already fresh", async () => {
    // Pre-populate the cache so the prime sees fresh data and skips the
    // `getAuth`/`checkQuota` path entirely. We use an empty-ish but non-empty
    // map (an overage entry) so `setLastRateLimits` accepts it and writes the
    // `at` timestamp.
    setLastRateLimits(
      new Map<string, string>([["anthropic-ratelimit-unified-overage-status", "off"]]),
    )
    // No transport configured; if the prime tried to talk to the network it
    // would surface here. `setLastRateLimits` populated `at = Date.now()`
    // which is inside the freshness window, so the prime's cache-first check
    // returns before any I/O.
    await expect(primeAnthropicSessionInfo({ modelId: "claude-opus-4-8" })).resolves.toBeUndefined()
  })

  it("probes through the canonical probeQuota (B-0 flip), not the legacy checkQuota", async () => {
    // Pin the WIRE SHAPE of the cold-start prime probe. The canonical
    // probeQuota body is exactly {model, max_tokens, messages} — the legacy
    // checkQuota body additionally carried a `metadata` envelope. Wiring
    // prime → probeQuota is flip-checklist item 3 (PLAN.md §2); this test
    // is its red→green proof and its regression pin.
    const prevTestAuth = process.env.MINIMAL_AGENT_TEST_AUTH
    process.env.MINIMAL_AGENT_TEST_AUTH = "1" // getAuth() → synthetic oauth (test env only)
    try {
      let seenUrl = ""
      let seenBody: Record<string, unknown> | null = null
      const networkClient = {
        request: async (req: { url: string; body?: string }) => {
          seenUrl = req.url
          seenBody = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : null
          return new Response("{}", {
            status: 200,
            headers: { "anthropic-ratelimit-unified-5h-utilization": "0.33" },
          })
        },
      }
      await primeAnthropicSessionInfo({
        modelId: "claude-opus-4-8",
        networkClient,
      })
      expect(seenUrl).toContain("api.anthropic.com/v1/messages")
      expect(seenBody).not.toBeNull()
      // Canonical probe shape: no metadata envelope, 1-token bare user msg.
      expect(Object.keys(seenBody!).sort()).toEqual(["max_tokens", "messages", "model"])
      expect(seenBody!.max_tokens).toBe(1)
      // The broadcast side effect populated the cache.
      expect(
        getLastRateLimits()?.rateLimits.get("anthropic-ratelimit-unified-5h-utilization"),
      ).toBe("0.33")
    } finally {
      if (prevTestAuth === undefined) delete process.env.MINIMAL_AGENT_TEST_AUTH
      else process.env.MINIMAL_AGENT_TEST_AUTH = prevTestAuth
    }
  })

  it("dedupes concurrent calls into a single in-flight promise", async () => {
    // Pre-populate the cache so the inner IIFE hits the cache-fresh fast path
    // and resolves synchronously through a microtask. This isolates the
    // dedupe contract (reference identity of the in-flight Promise) from
    // any network I/O — the prime function is a non-`async` function so
    // both concurrent callers see the SAME promise instance synchronously
    // (call A sets `inFlightPrime`, call B reads it on the early-return).
    setLastRateLimits(
      new Map<string, string>([["anthropic-ratelimit-unified-overage-status", "off"]]),
    )
    const a = primeAnthropicSessionInfo({ modelId: "claude-opus-4-8" })
    const b = primeAnthropicSessionInfo({ modelId: "claude-opus-4-8" })
    // Reference identity is the dedupe contract. An `async`-wrapped
    // implementation would mint a fresh wrapper per call and break this.
    expect(a).toBe(b)
    await Promise.all([a, b])
    // After settle, the latch resets so a later prime is a NEW attempt
    // (different Promise instance).
    const c = primeAnthropicSessionInfo({ modelId: "claude-opus-4-8" })
    expect(c).not.toBe(a)
    await c
  })
})

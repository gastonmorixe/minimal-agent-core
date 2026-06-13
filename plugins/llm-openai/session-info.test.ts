/**
 * OpenAI session-metadata tests.
 *
 * Covers the duration parser, the `x-ratelimit-*` → neutral `QuotaWindow[]`
 * mapping, and the cache-backed `fetchOpenAISessionInfo` (cache present →
 * windows; no/stale cache → `{}`). No network: OpenAI windows come from real
 * traffic captured into the module cache by the adapter.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { ProviderSessionContext } from "@minimal-agent/plugin-api/llm/provider-plugin"

import {
  clearOpenAIRateLimits,
  fetchOpenAISessionInfo,
  getOpenAIRateLimits,
  parseOpenAIQuotaWindows,
  parseOpenAIResetMs,
  setOpenAIRateLimits,
} from "./session-info.ts"

/** Build a lowercased map of `x-ratelimit-*` entries for the parser tests. */
function rl(entries: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>()
  for (const [k, v] of Object.entries(entries)) m.set(k.toLowerCase(), v)
  return m
}

const ctx: ProviderSessionContext = { modelId: "gpt-5.5" }

beforeEach(() => clearOpenAIRateLimits())
afterEach(() => clearOpenAIRateLimits())

// ---------------------------------------------------------------------------
// parseOpenAIResetMs
// ---------------------------------------------------------------------------

describe("parseOpenAIResetMs", () => {
  it("parses simple second/minute/millisecond durations", () => {
    expect(parseOpenAIResetMs("1s")).toBe(1000)
    expect(parseOpenAIResetMs("6m0s")).toBe(360_000)
    expect(parseOpenAIResetMs("13ms")).toBe(13)
    expect(parseOpenAIResetMs("0s")).toBe(0)
  })

  it("parses compound + fractional durations", () => {
    expect(parseOpenAIResetMs("1h2m3s")).toBe(3_600_000 + 120_000 + 3000)
    expect(parseOpenAIResetMs("1.5s")).toBe(1500)
  })

  it("returns undefined for empty or garbage input", () => {
    expect(parseOpenAIResetMs("")).toBeUndefined()
    expect(parseOpenAIResetMs("   ")).toBeUndefined()
    expect(parseOpenAIResetMs("abc")).toBeUndefined()
    expect(parseOpenAIResetMs("12")).toBeUndefined()
    expect(parseOpenAIResetMs("1s extra")).toBeUndefined()
    // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding a non-string.
    expect(parseOpenAIResetMs(undefined as any)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseOpenAIQuotaWindows
// ---------------------------------------------------------------------------

describe("parseOpenAIQuotaWindows", () => {
  it("builds req + tok windows with correct utilization and resetAtMs", () => {
    const before = Date.now()
    const windows = parseOpenAIQuotaWindows(
      rl({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "75",
        "x-ratelimit-reset-requests": "6m0s",
        "x-ratelimit-limit-tokens": "1000",
        "x-ratelimit-remaining-tokens": "250",
        "x-ratelimit-reset-tokens": "1s",
      }),
    )
    const after = Date.now()

    expect(windows.map((w) => w.id)).toEqual(["req", "tok"])

    const req = windows.find((w) => w.id === "req")!
    expect(req.utilization).toBeCloseTo(0.25, 10) // 1 - 75/100
    expect(req.resetAtMs!).toBeGreaterThanOrEqual(before + 360_000)
    expect(req.resetAtMs!).toBeLessThanOrEqual(after + 360_000)

    const tok = windows.find((w) => w.id === "tok")!
    expect(tok.utilization).toBeCloseTo(0.75, 10) // 1 - 250/1000
    expect(tok.resetAtMs!).toBeGreaterThanOrEqual(before + 1000)
    expect(tok.resetAtMs!).toBeLessThanOrEqual(after + 1000)
  })

  it("emits only the req window when token headers are missing", () => {
    const windows = parseOpenAIQuotaWindows(
      rl({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "100",
        "x-ratelimit-reset-requests": "0s",
      }),
    )
    expect(windows.map((w) => w.id)).toEqual(["req"])
    expect(windows[0]!.utilization).toBe(0) // 1 - 100/100
    expect(windows[0]!.resetAtMs).toBeDefined()
  })

  it("clamps utilization into [0,1] and omits resetAtMs for unparseable reset", () => {
    const windows = parseOpenAIQuotaWindows(
      rl({
        // remaining > limit ⇒ negative raw utilization ⇒ clamp to 0.
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "150",
        "x-ratelimit-reset-requests": "garbage",
      }),
    )
    expect(windows).toHaveLength(1)
    expect(windows[0]!.utilization).toBe(0)
    expect(windows[0]!.resetAtMs).toBeUndefined()
  })

  it("skips a window with limit<=0 or absent limit/remaining headers", () => {
    expect(
      parseOpenAIQuotaWindows(
        rl({
          "x-ratelimit-limit-requests": "0",
          "x-ratelimit-remaining-requests": "0",
        }),
      ),
    ).toEqual([])
    // limit present, remaining absent ⇒ skip.
    expect(parseOpenAIQuotaWindows(rl({ "x-ratelimit-limit-tokens": "100" }))).toEqual([])
  })

  it("returns [] for an empty map", () => {
    expect(parseOpenAIQuotaWindows(rl({}))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// setOpenAIRateLimits / cache
// ---------------------------------------------------------------------------

describe("setOpenAIRateLimits", () => {
  it("copies only x-ratelimit-* entries and stamps the capture time", () => {
    const headers = new Headers({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "99",
      "content-type": "text/event-stream",
    })
    const before = Date.now()
    setOpenAIRateLimits(headers)
    const cached = getOpenAIRateLimits()!
    expect(cached).not.toBeNull()
    expect(cached.at).toBeGreaterThanOrEqual(before)
    expect(cached.rateLimits.get("x-ratelimit-limit-requests")).toBe("100")
    expect(cached.rateLimits.has("content-type")).toBe(false)
  })

  it("ignores headers with no x-ratelimit-* entries (does not blank the cache)", () => {
    setOpenAIRateLimits(new Headers({ "x-ratelimit-limit-requests": "5" }))
    setOpenAIRateLimits(new Headers({ "content-type": "application/json" }))
    expect(getOpenAIRateLimits()!.rateLimits.get("x-ratelimit-limit-requests")).toBe("5")
  })
})

// ---------------------------------------------------------------------------
// fetchOpenAISessionInfo
// ---------------------------------------------------------------------------

describe("fetchOpenAISessionInfo", () => {
  it("returns quota.windows after setOpenAIRateLimits captured real headers", async () => {
    setOpenAIRateLimits(
      new Headers({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "80",
        "x-ratelimit-reset-requests": "1s",
        "x-ratelimit-limit-tokens": "1000",
        "x-ratelimit-remaining-tokens": "900",
        "x-ratelimit-reset-tokens": "2s",
      }),
    )
    const info = await fetchOpenAISessionInfo(ctx)
    expect(info).not.toBeNull()
    expect(info!.quota?.windows.map((w) => w.id)).toEqual(["req", "tok"])
  })

  it("returns {} with no cache (no quota — core backfills context/label)", async () => {
    const info = await fetchOpenAISessionInfo(ctx)
    expect(info).toEqual({})
  })

  it("returns {} when the cached headers carry no usable windows", async () => {
    setOpenAIRateLimits(new Headers({ "x-ratelimit-limit-requests": "0" }))
    const info = await fetchOpenAISessionInfo(ctx)
    expect(info).toEqual({})
  })

  it("returns {} (does no work) when the signal is already aborted", async () => {
    setOpenAIRateLimits(
      new Headers({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "1",
        "x-ratelimit-reset-requests": "1s",
      }),
    )
    const info = await fetchOpenAISessionInfo({ ...ctx, signal: AbortSignal.abort() })
    expect(info).toEqual({})
  })
})

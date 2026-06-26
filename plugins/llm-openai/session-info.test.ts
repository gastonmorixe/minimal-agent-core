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
  parseCodexQuotaWindows,
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
// parseCodexQuotaWindows (ChatGPT/Codex plan family — x-codex-*)
// ---------------------------------------------------------------------------

describe("parseCodexQuotaWindows", () => {
  it("builds 5h + 7d windows from primary/secondary headers (live header shape)", () => {
    const before = Date.now()
    // Shape captured live from chatgpt.com/backend-api/codex/responses.
    const windows = parseCodexQuotaWindows(
      rl({
        "x-codex-primary-used-percent": "96",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-after-seconds": "16884",
        "x-codex-secondary-used-percent": "39",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-after-seconds": "323959",
      }),
    )
    const after = Date.now()

    expect(windows.map((w) => w.id)).toEqual(["5h", "7d"])

    const primary = windows.find((w) => w.id === "5h")!
    expect(primary.utilization).toBeCloseTo(0.96, 10)
    expect(primary.resetAtMs!).toBeGreaterThanOrEqual(before + 16884 * 1000)
    expect(primary.resetAtMs!).toBeLessThanOrEqual(after + 16884 * 1000)

    const secondary = windows.find((w) => w.id === "7d")!
    expect(secondary.utilization).toBeCloseTo(0.39, 10)
  })

  it("prefers absolute reset-at (unix seconds) over reset-after-seconds", () => {
    const windows = parseCodexQuotaWindows(
      rl({
        "x-codex-primary-used-percent": "10",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1782406189",
        "x-codex-primary-reset-after-seconds": "16918",
      }),
    )
    expect(windows).toHaveLength(1)
    expect(windows[0]!.resetAtMs).toBe(1782406189 * 1000)
  })

  it("humanizes window-minutes (1440 → 1d, 90 → 90m) and falls back per slot", () => {
    const dayWin = parseCodexQuotaWindows(
      rl({ "x-codex-primary-used-percent": "5", "x-codex-primary-window-minutes": "1440" }),
    )
    expect(dayWin[0]!.id).toBe("1d")

    const oddWin = parseCodexQuotaWindows(
      rl({ "x-codex-secondary-used-percent": "5", "x-codex-secondary-window-minutes": "90" }),
    )
    expect(oddWin[0]!.id).toBe("90m")

    // No window-minutes header → conventional per-slot fallback id.
    const noMinutes = parseCodexQuotaWindows(rl({ "x-codex-primary-used-percent": "5" }))
    expect(noMinutes[0]!.id).toBe("5h")
  })

  it("clamps utilization into [0,1] and omits resetAtMs when no reset header parses", () => {
    const windows = parseCodexQuotaWindows(
      rl({ "x-codex-primary-used-percent": "150", "x-codex-primary-window-minutes": "300" }),
    )
    expect(windows).toHaveLength(1)
    expect(windows[0]!.utilization).toBe(1)
    expect(windows[0]!.resetAtMs).toBeUndefined()
  })

  it("skips a slot whose used-percent header is absent or unparseable", () => {
    expect(parseCodexQuotaWindows(rl({ "x-codex-primary-window-minutes": "300" }))).toEqual([])
    expect(parseCodexQuotaWindows(rl({ "x-codex-primary-used-percent": "n/a" }))).toEqual([])
  })

  it("returns [] for an empty / non-codex map", () => {
    expect(parseCodexQuotaWindows(rl({}))).toEqual([])
    expect(parseCodexQuotaWindows(rl({ "x-ratelimit-limit-requests": "100" }))).toEqual([])
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

  it("captures the x-codex-* plan family (ChatGPT OAuth traffic)", () => {
    setOpenAIRateLimits(
      new Headers({
        "x-codex-primary-used-percent": "96",
        "x-codex-primary-window-minutes": "300",
        "x-codex-plan-type": "plus",
        "content-type": "text/event-stream",
      }),
    )
    const cached = getOpenAIRateLimits()!
    expect(cached.rateLimits.get("x-codex-primary-used-percent")).toBe("96")
    expect(cached.rateLimits.get("x-codex-plan-type")).toBe("plus")
    expect(cached.rateLimits.has("content-type")).toBe(false)
  })

  // The emit-on-cache contract (setOpenAIRateLimits → quota.headersReceived,
  // so the footer repaints this turn instead of on the 5-min heartbeat) is
  // pinned in src/quota-broadcast.test.ts via `announceQuotaRefresh`, which
  // setOpenAIRateLimits calls. Asserting the bus wiring here would force a new
  // plugin→src import (EventBus/global-bus) and trip the decoupling ratchet,
  // so the emit pin lives on the core side where the bus already lives.
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

  it("returns 5h/7d quota.windows from cached x-codex-* headers (OAuth path)", async () => {
    setOpenAIRateLimits(
      new Headers({
        "x-codex-primary-used-percent": "96",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-after-seconds": "16884",
        "x-codex-secondary-used-percent": "39",
        "x-codex-secondary-window-minutes": "10080",
      }),
    )
    const info = await fetchOpenAISessionInfo(ctx)
    expect(info!.quota?.windows.map((w) => w.id)).toEqual(["5h", "7d"])
    expect(info!.quota?.windows[0]!.utilization).toBeCloseTo(0.96, 10)
  })

  it("prefers Codex 5h/7d windows over req/tok when both families are cached", async () => {
    setOpenAIRateLimits(
      new Headers({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "80",
        "x-codex-primary-used-percent": "50",
        "x-codex-primary-window-minutes": "300",
      }),
    )
    const info = await fetchOpenAISessionInfo(ctx)
    expect(info!.quota?.windows.map((w) => w.id)).toEqual(["5h"])
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

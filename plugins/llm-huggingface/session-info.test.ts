/**
 * HuggingFace session-metadata tests (mirror of the OpenRouter provider's).
 *
 * @module llm/providers/huggingface/session-info.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import {
  clearHuggingFaceRateLimits,
  fetchHuggingFaceSessionInfo,
  parseHuggingFaceQuotaWindows,
  parseHuggingFaceResetMs,
  setHuggingFaceRateLimits,
} from "./session-info.ts"

afterEach(() => clearHuggingFaceRateLimits())

describe("parseHuggingFaceResetMs", () => {
  it("parses Go-style durations", () => {
    expect(parseHuggingFaceResetMs("1s")).toBe(1000)
    expect(parseHuggingFaceResetMs("6m0s")).toBe(360_000)
    expect(parseHuggingFaceResetMs("13ms")).toBe(13)
    expect(parseHuggingFaceResetMs("0s")).toBe(0)
    expect(parseHuggingFaceResetMs("1h2m3s")).toBe(3_600_000 + 120_000 + 3000)
  })
  it("returns undefined for empty/garbage", () => {
    expect(parseHuggingFaceResetMs("")).toBeUndefined()
    expect(parseHuggingFaceResetMs("nope")).toBeUndefined()
    expect(parseHuggingFaceResetMs("12 34")).toBeUndefined()
  })
})

describe("parseHuggingFaceQuotaWindows", () => {
  it("builds req + tok windows with clamped utilization + resetAtMs", () => {
    const rl = new Map<string, string>([
      ["x-ratelimit-limit-requests", "100"],
      ["x-ratelimit-remaining-requests", "75"],
      ["x-ratelimit-reset-requests", "2s"],
      ["x-ratelimit-limit-tokens", "1000"],
      ["x-ratelimit-remaining-tokens", "100"],
    ])
    const t0 = Date.now()
    const wins = parseHuggingFaceQuotaWindows(rl)
    expect(wins.map((w) => w.id)).toEqual(["req", "tok"])
    expect(wins[0]?.utilization).toBeCloseTo(0.25)
    expect(wins[0]?.resetAtMs).toBeGreaterThanOrEqual(t0 + 2000 - 50)
    expect(wins[1]?.utilization).toBeCloseTo(0.9)
    expect(wins[1]?.resetAtMs).toBeUndefined() // no reset header for tok
  })
  it("skips a window with missing/zero limit; empty map -> []", () => {
    expect(parseHuggingFaceQuotaWindows(new Map())).toEqual([])
    expect(
      parseHuggingFaceQuotaWindows(new Map([["x-ratelimit-remaining-requests", "5"]])),
    ).toEqual([])
  })
})

describe("fetchHuggingFaceSessionInfo", () => {
  it("returns quota windows after a fresh capture", async () => {
    const h = new Headers({
      "x-ratelimit-limit-requests": "50",
      "x-ratelimit-remaining-requests": "40",
    })
    setHuggingFaceRateLimits(h)
    const info = await fetchHuggingFaceSessionInfo({ modelId: "x" })
    expect(info?.quota?.windows[0]?.id).toBe("req")
    expect(info?.quota?.windows[0]?.utilization).toBeCloseTo(0.2)
  })
  it("returns {} (context-only) with no cache", async () => {
    const info = await fetchHuggingFaceSessionInfo({ modelId: "x" })
    expect(info).toEqual({})
  })
  it("ignores a response with no x-ratelimit-* headers", async () => {
    setHuggingFaceRateLimits(new Headers({ "content-type": "text/event-stream" }))
    const info = await fetchHuggingFaceSessionInfo({ modelId: "x" })
    expect(info).toEqual({})
  })
  it("returns {} when the signal is already aborted", async () => {
    const h = new Headers({
      "x-ratelimit-limit-requests": "50",
      "x-ratelimit-remaining-requests": "40",
    })
    setHuggingFaceRateLimits(h)
    const ac = new AbortController()
    ac.abort()
    expect(await fetchHuggingFaceSessionInfo({ modelId: "x", signal: ac.signal })).toEqual({})
  })
})

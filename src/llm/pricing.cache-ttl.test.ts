import { describe, expect, it } from "bun:test"

import { calculateUsageCost, type MTokRate } from "./pricing.ts"

// Opus 5.5 list rates: https://platform.claude.com/docs/en/about-claude/pricing
const RATE: MTokRate = {
  inputUSD: 4,
  outputUSD: 20,
  cacheWriteUSD: 5,
  cacheWrite1hUSD: 8,
  cacheReadUSD: 0.2,
  webSearchPerCallUSD: 0.01,
}

describe("calculateUsageCost cache TTL split", () => {
  it("prices the 1h part of cache writes at cacheWrite1hUSD", () => {
    const cost = calculateUsageCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 1_000_000,
        cacheBreakdown: { fiveMinute: 750_000, oneHour: 250_000 },
      },
      RATE,
    )
    expect(cost.cacheCreationUSD).toBeCloseTo(0.75 * 5 + 0.25 * 8, 9)
  })

  it("uses cacheWriteUSD for every write when the rate has no 1h tier", () => {
    const { cacheWrite1hUSD: _omit, ...flat } = RATE
    const cost = calculateUsageCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 1_000_000,
        cacheBreakdown: { oneHour: 1_000_000 },
      },
      flat,
    )
    expect(cost.cacheCreationUSD).toBeCloseTo(5, 9)
  })

  it("clamps a 1h count larger than the total", () => {
    const cost = calculateUsageCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 100,
        cacheBreakdown: { oneHour: 500 },
      },
      RATE,
    )
    expect(cost.cacheCreationUSD).toBeCloseTo((100 * 8) / 1e6, 12)
  })

  it("does not bill thinking tokens twice when no reasoning surcharge is set", () => {
    const cost = calculateUsageCost(
      { inputTokens: 0, outputTokens: 1000, reasoningTokens: 400 },
      RATE,
    )
    expect(cost.totalUSD).toBeCloseTo((1000 * 20) / 1e6, 12)
  })
})

/**
 * Anthropic pricing-table characterization.
 *
 * The cost arithmetic itself (`calculateUsageCost`) is provider-neutral and
 * tested in `src/llm/llm.test.ts`; this file pins the Anthropic rate DATA
 * (the `Fp` standard rate and the `cx1` 2x fast-tier relationship) that lives
 * in this plugin.
 *
 * @module llm/providers/anthropic/pricing.test
 */

import { describe, expect, it } from "bun:test"

import { calculateUsageCost } from "../../src/llm/pricing.ts"

import { sonnet5RateForDate } from "./models.ts"
import {
  ANTHROPIC_OPUS_4X_STANDARD,
  ANTHROPIC_OPUS_48_FAST,
  ANTHROPIC_SONNET_5_INTRO,
  ANTHROPIC_SONNET_STANDARD,
} from "./pricing.ts"

describe("anthropic pricing tables", () => {
  it("calculateUsageCost matches the documented Fp standard rate", () => {
    const cost = calculateUsageCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
      },
      ANTHROPIC_OPUS_4X_STANDARD,
    )
    expect(cost.inputUSD).toBeCloseTo(5)
    expect(cost.outputUSD).toBeCloseTo(25)
    expect(cost.cacheReadUSD).toBeCloseTo(0.5)
    expect(cost.cacheCreationUSD).toBeCloseTo(6.25)
    expect(cost.totalUSD).toBeCloseTo(36.75)
  })

  it("the fast rate is 2x standard input/output", () => {
    expect(ANTHROPIC_OPUS_48_FAST.inputUSD).toBe(ANTHROPIC_OPUS_4X_STANDARD.inputUSD * 2)
    expect(ANTHROPIC_OPUS_48_FAST.outputUSD).toBe(ANTHROPIC_OPUS_4X_STANDARD.outputUSD * 2)
  })
})

describe("sonnet 5 introductory pricing", () => {
  it("intro rate is the documented $2 / $10 per Mtok", () => {
    expect(ANTHROPIC_SONNET_5_INTRO.inputUSD).toBe(2)
    expect(ANTHROPIC_SONNET_5_INTRO.outputUSD).toBe(10)
  })

  it("standard rate (post-2026-09-01) is the documented $3 / $15 per Mtok", () => {
    expect(ANTHROPIC_SONNET_STANDARD.inputUSD).toBe(3)
    expect(ANTHROPIC_SONNET_STANDARD.outputUSD).toBe(15)
  })

  it("applies the intro rate before the 2026-09-01 cutover", () => {
    // Launch day and the last intro day (2026-08-31) both get intro pricing.
    expect(sonnet5RateForDate(Date.UTC(2026, 5, 30))).toBe(ANTHROPIC_SONNET_5_INTRO)
    expect(sonnet5RateForDate(Date.UTC(2026, 7, 31, 23, 59, 59))).toBe(ANTHROPIC_SONNET_5_INTRO)
  })

  it("switches to the standard rate at the 2026-09-01 boundary and after", () => {
    expect(sonnet5RateForDate(Date.UTC(2026, 8, 1, 0, 0, 0))).toBe(ANTHROPIC_SONNET_STANDARD)
    expect(sonnet5RateForDate(Date.UTC(2026, 11, 25))).toBe(ANTHROPIC_SONNET_STANDARD)
  })
})

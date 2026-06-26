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

import { ANTHROPIC_OPUS_4X_STANDARD, ANTHROPIC_OPUS_48_FAST } from "./pricing.ts"

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

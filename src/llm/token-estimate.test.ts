import { afterEach, describe, expect, it } from "bun:test"

import { defaultCapabilities } from "./capabilities.ts"
import { clearModelRegistry, type ModelEntry, registerModel } from "./model-registry.ts"
import { ANTHROPIC_OPUS_4X_STANDARD } from "./pricing.ts"
import {
  DEFAULT_CHARS_PER_TOKEN,
  estimateTokensForModel,
  estimateTokensFromText,
  makeCharRatioEstimator,
} from "./token-estimate.ts"

afterEach(() => clearModelRegistry())

function buildEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "test-model",
    providerId: "test",
    surfaceId: "custom",
    displayName: "Test Model",
    capabilities: defaultCapabilities(),
    pricing: ANTHROPIC_OPUS_4X_STANDARD,
    ...overrides,
  }
}

describe("makeCharRatioEstimator", () => {
  it("estimates ceil(chars / ratio)", () => {
    const est = makeCharRatioEstimator(4)
    expect(est("")).toBe(0)
    expect(est("abcd")).toBe(1)
    expect(est("abcde")).toBe(2) // ceil(5/4)
    expect(est("a".repeat(40))).toBe(10)
  })

  it("falls back to the default ratio on non-positive / non-finite input", () => {
    const bad = makeCharRatioEstimator(0)
    const good = makeCharRatioEstimator(DEFAULT_CHARS_PER_TOKEN)
    const sample = "x".repeat(35)
    expect(bad(sample)).toBe(good(sample))
    expect(makeCharRatioEstimator(Number.NaN)("x".repeat(7))).toBe(good("x".repeat(7)))
  })
})

describe("estimateTokensFromText", () => {
  it("uses the default ratio when none given", () => {
    // 35 chars / 3.5 = 10
    expect(estimateTokensFromText("y".repeat(35))).toBe(10)
  })

  it("honors a custom ratio", () => {
    expect(estimateTokensFromText("y".repeat(40), 4)).toBe(10)
  })
})

describe("estimateTokensForModel", () => {
  it("uses the model's registered estimator when present", () => {
    registerModel(buildEntry({ estimateTokens: makeCharRatioEstimator(2) }))
    // 10 chars / 2 = 5 (vs the 3.5 default which would be 3)
    expect(estimateTokensForModel("test-model", "x".repeat(10))).toBe(5)
  })

  it("resolves through aliases", () => {
    registerModel(
      buildEntry({ aliases: ["test-alias"], estimateTokens: makeCharRatioEstimator(2) }),
    )
    expect(estimateTokensForModel("test-alias", "x".repeat(10))).toBe(5)
  })

  it("falls back to the default ratio for an unknown / forward-compat model id", () => {
    expect(estimateTokensForModel("never-registered", "z".repeat(35))).toBe(10)
  })

  it("falls back to the default ratio when modelId is undefined", () => {
    expect(estimateTokensForModel(undefined, "z".repeat(35))).toBe(10)
  })

  it("falls back when a registered model has no estimator", () => {
    registerModel(buildEntry({ id: "no-estimator" }))
    expect(estimateTokensForModel("no-estimator", "z".repeat(35))).toBe(10)
  })
})

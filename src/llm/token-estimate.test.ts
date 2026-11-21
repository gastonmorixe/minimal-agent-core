import { afterEach, describe, expect, it } from "bun:test"

import { defaultCapabilities } from "./capabilities.ts"
import { clearModelRegistry, type ModelEntry, registerModel } from "./model-registry.ts"
import type { MTokRate } from "./pricing.ts"
import {
  estimateTokensForModel,
  lookupTokenEstimator,
  makeCharRatioEstimator,
} from "./token-estimate.ts"

afterEach(() => clearModelRegistry())

const TEST_RATE: MTokRate = {
  inputUSD: 5,
  outputUSD: 25,
  cacheWriteUSD: 6.25,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0.01,
}

function buildEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "test-model",
    providerId: "test",
    surfaceId: "custom",
    displayName: "Test Model",
    capabilities: defaultCapabilities(),
    pricing: TEST_RATE,
    ...overrides,
  }
}

describe("makeCharRatioEstimator (re-export)", () => {
  it("estimates ceil(chars / ratio)", () => {
    const est = makeCharRatioEstimator(4)
    expect(est("")).toBe(0)
    expect(est("abcde")).toBe(2) // ceil(5/4)
  })

  it("throws on a bad ratio (no default ratio in core)", () => {
    expect(() => makeCharRatioEstimator(0)).toThrow(RangeError)
    expect(() => makeCharRatioEstimator(Number.NaN)).toThrow(RangeError)
  })
})

describe("lookupTokenEstimator", () => {
  it("gives the provider-scoped estimator before the global one", () => {
    const a = makeCharRatioEstimator(2)
    const b = makeCharRatioEstimator(5)
    registerModel(buildEntry({ providerId: "prov-a", estimateTokens: a }))
    registerModel(buildEntry({ providerId: "prov-b", estimateTokens: b }))
    expect(lookupTokenEstimator("test-model", "prov-a")).toBe(a)
    expect(lookupTokenEstimator("test-model", "prov-b")).toBe(b)
  })

  it("falls back to the global id when the provider has no entry", () => {
    const a = makeCharRatioEstimator(2)
    registerModel(buildEntry({ providerId: "prov-a", estimateTokens: a }))
    expect(lookupTokenEstimator("test-model", "other-provider")).toBe(a)
    expect(lookupTokenEstimator("test-model")).toBe(a)
  })

  it("falls back to the global id when the scoped entry has no estimator", () => {
    const b = makeCharRatioEstimator(5)
    registerModel(buildEntry({ providerId: "prov-b", estimateTokens: b }))
    registerModel(buildEntry({ providerId: "prov-a" }))
    // The global id is the last registered entry (prov-a, no estimator).
    expect(lookupTokenEstimator("test-model", "prov-a")).toBeUndefined()
    expect(lookupTokenEstimator("test-model", "prov-b")).toBe(b)
  })

  it("gives undefined for no model, an unknown model, or no estimator", () => {
    expect(lookupTokenEstimator(undefined)).toBeUndefined()
    expect(lookupTokenEstimator("never-registered", "prov-a")).toBeUndefined()
    registerModel(buildEntry({ id: "no-estimator" }))
    expect(lookupTokenEstimator("no-estimator")).toBeUndefined()
  })
})

describe("estimateTokensForModel", () => {
  it("uses the model's registered estimator when present", () => {
    registerModel(buildEntry({ estimateTokens: makeCharRatioEstimator(2) }))
    expect(estimateTokensForModel("test-model", "x".repeat(10))).toBe(5)
  })

  it("resolves through aliases", () => {
    registerModel(
      buildEntry({ aliases: ["test-alias"], estimateTokens: makeCharRatioEstimator(2) }),
    )
    expect(estimateTokensForModel("test-alias", "x".repeat(10))).toBe(5)
  })

  it("uses the provider scope", () => {
    registerModel(buildEntry({ providerId: "prov-a", estimateTokens: makeCharRatioEstimator(2) }))
    registerModel(buildEntry({ providerId: "prov-b", estimateTokens: makeCharRatioEstimator(5) }))
    expect(estimateTokensForModel("test-model", "x".repeat(10), "prov-a")).toBe(5)
    expect(estimateTokensForModel("test-model", "x".repeat(10), "prov-b")).toBe(2)
  })

  it("gives undefined for an unknown / forward-compat model id (no fallback)", () => {
    expect(estimateTokensForModel("never-registered", "z".repeat(35))).toBeUndefined()
  })

  it("gives undefined when modelId is undefined", () => {
    expect(estimateTokensForModel(undefined, "z".repeat(35))).toBeUndefined()
  })

  it("gives undefined when a registered model has no estimator", () => {
    registerModel(buildEntry({ id: "no-estimator" }))
    expect(estimateTokensForModel("no-estimator", "z".repeat(35))).toBeUndefined()
  })
})

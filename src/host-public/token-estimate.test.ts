import { afterEach, describe, expect, test } from "bun:test"

import {
  estimateTokensForModel,
  lookupTokenEstimator,
} from "@minimal-agent/core/host/token-estimate"

import { defaultCapabilities } from "../llm/capabilities.ts"
import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"
import {
  estimateTokensForModel as innerEstimate,
  lookupTokenEstimator as innerLookup,
  makeCharRatioEstimator,
} from "../llm/token-estimate.ts"

afterEach(() => clearModelRegistry())

describe("host-public/token-estimate", () => {
  test("re-exports the core lookup and estimate", () => {
    expect(estimateTokensForModel).toBe(innerEstimate)
    expect(lookupTokenEstimator).toBe(innerLookup)
  })
  test("unknown model gives undefined (no default ratio)", () => {
    expect(estimateTokensForModel("no-such-model-xyz", "hello world ".repeat(50))).toBeUndefined()
    expect(lookupTokenEstimator("no-such-model-xyz")).toBeUndefined()
    expect(estimateTokensForModel(undefined, "")).toBeUndefined()
  })
  test("a registered estimator gives an integer >= 0", () => {
    registerModel({
      id: "host-te-model",
      providerId: "host-te",
      surfaceId: "custom",
      displayName: "Host TE",
      capabilities: defaultCapabilities(),
      pricing: {
        inputUSD: 1,
        outputUSD: 1,
        cacheWriteUSD: 1,
        cacheReadUSD: 1,
        webSearchPerCallUSD: 0,
      },
      estimateTokens: makeCharRatioEstimator(4),
    })
    expect(estimateTokensForModel("host-te-model", "x".repeat(40), "host-te")).toBe(10)
  })
})

/**
 * Regression: dual-registered bare model ids (e.g. the same slug under both
 * a first-party provider and a gateway) must validate effort against the
 * SELECTED provider's caps, not unscoped last-write-wins. Lead ModelInfo said
 * low|medium|high (first-party) but child boot fatally rejected low with
 * supported medium|high|max (gateway last-write).
 *
 * Provider / surface ids here are intentionally generic so this test stays
 * outside the provider-token architecture baseline.
 *
 * @module host/startup/startup-rows.effort.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { defaultCapabilities } from "../../llm/capabilities.ts"
import { clearModelRegistry, registerModel } from "../../llm/model-registry.ts"
import type { MTokRate } from "../../llm/pricing.ts"
import { makeCharRatioEstimator } from "../../llm/token-estimate.ts"

import { validateStartupEffort } from "./startup-rows.ts"

const RATE: MTokRate = {
  inputUSD: 1,
  outputUSD: 2,
  cacheWriteUSD: 1,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}

const SHARED = "dual-effort-model"

function registerDual(): void {
  registerModel({
    id: SHARED,
    providerId: "firstparty",
    surfaceId: "responses",
    displayName: "Dual Effort (First-party)",
    capabilities: {
      ...defaultCapabilities(),
      effort: { levels: ["low", "medium", "high"], default: "high" },
    },
    pricing: RATE,
    estimateTokens: makeCharRatioEstimator(3.5),
  })
  // Register second so unscoped findModel last-write-wins to the gateway.
  registerModel({
    id: SHARED,
    providerId: "gateway",
    surfaceId: "chat-completions",
    displayName: "Dual Effort (Gateway)",
    capabilities: {
      ...defaultCapabilities(),
      effort: { levels: ["medium", "high", "max"], default: "medium" },
    },
    pricing: RATE,
    estimateTokens: makeCharRatioEstimator(3.5),
  })
}

describe("validateStartupEffort provider scoping", () => {
  beforeEach(() => {
    clearModelRegistry()
    registerDual()
  })
  afterEach(() => {
    clearModelRegistry()
  })

  it("allows effort=low when the selected provider is firstparty (not gateway last-write)", () => {
    expect(() => validateStartupEffort(false, SHARED, "low", "firstparty")).not.toThrow()
  })

  it("rejects effort=low when the selected provider is gateway", () => {
    expect(() => validateStartupEffort(false, SHARED, "low", "gateway")).toThrow(
      /medium, high, max/,
    )
  })

  it("rejects effort=max on firstparty (first-party levels have no max)", () => {
    expect(() => validateStartupEffort(false, SHARED, "max", "firstparty")).toThrow(
      /low, medium, high/,
    )
  })

  it("no-ops when hidesReasoning is true", () => {
    expect(() => validateStartupEffort(true, SHARED, "low", "gateway")).not.toThrow()
  })
})

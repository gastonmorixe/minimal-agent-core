/**
 * Regression: dual-registered bare model ids (e.g. grok-4.5 under both
 * `grok` and `opencode`) must validate effort against the SELECTED provider's
 * caps, not unscoped last-write-wins. Carlos smoke: lead ModelInfo said
 * low|medium|high (grok) but child boot fatally rejected low with
 * supported medium|high|max (opencode last-write).
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
    providerId: "grok",
    surfaceId: "openai-responses",
    displayName: "Dual Effort (Grok)",
    capabilities: {
      ...defaultCapabilities(),
      effort: { levels: ["low", "medium", "high"], default: "high" },
    },
    pricing: RATE,
    estimateTokens: makeCharRatioEstimator(3.5),
  })
  // Register second so unscoped findModel last-write-wins to opencode.
  registerModel({
    id: SHARED,
    providerId: "opencode",
    surfaceId: "openai-chat-completions",
    displayName: "Dual Effort (OpenCode)",
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

  it("allows effort=low when the selected provider is grok (not opencode last-write)", () => {
    expect(() => validateStartupEffort(false, SHARED, "low", "grok")).not.toThrow()
  })

  it("rejects effort=low when the selected provider is opencode", () => {
    expect(() => validateStartupEffort(false, SHARED, "low", "opencode")).toThrow(
      /medium, high, max/,
    )
  })

  it("rejects effort=max on grok (first-party levels have no max)", () => {
    expect(() => validateStartupEffort(false, SHARED, "max", "grok")).toThrow(/low, medium, high/)
  })

  it("no-ops when hidesReasoning is true", () => {
    expect(() => validateStartupEffort(true, SHARED, "low", "opencode")).not.toThrow()
  })
})

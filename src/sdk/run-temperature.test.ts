import { afterEach, describe, expect, it } from "bun:test"

import { defaultCapabilities } from "../llm/capabilities.ts"
import { DEFAULT_OUTPUT_SAFETY_MARGIN } from "../llm/context-budget.ts"
import { clearModelRegistry, type ModelEntry, registerModel } from "../llm/model-registry.ts"
import { makeCharRatioEstimator } from "../llm/token-estimate.ts"

import {
  emptyRunTemperature,
  lookupModelEntry,
  resolveMaxOutputTokens,
  resolveRunTemperature,
  runTemperatureOption,
  startRunTemperature,
  type WarnPort,
} from "./run-temperature.ts"

function testEntry(id: string, acceptsTemperature: boolean): ModelEntry {
  return {
    id,
    providerId: "test-provider",
    surfaceId: "test",
    displayName: id,
    capabilities: { ...defaultCapabilities(), acceptsTemperature },
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  } as ModelEntry
}

function fakeDiagnostics(): { diagnostics: WarnPort; warns: unknown[][] } {
  const warns: unknown[][] = []
  const diagnostics = { warn: (...args: unknown[]) => warns.push(args) } as WarnPort
  return { diagnostics, warns }
}

describe("resolveRunTemperature", () => {
  it("sends the value to a model that accepts temperature", () => {
    expect(resolveRunTemperature({ entry: testEntry("m", true), temperature: 0.3 })).toEqual({
      send: 0.3,
      ignored: false,
    })
  })

  it("drops the value and marks it ignored when acceptsTemperature is false", () => {
    expect(resolveRunTemperature({ entry: testEntry("m", false), temperature: 0.3 })).toEqual({
      ignored: true,
    })
  })

  it("sends the value when the model has no registry entry", () => {
    expect(resolveRunTemperature({ entry: undefined, temperature: 0 })).toEqual({
      send: 0,
      ignored: false,
    })
  })

  it("sends nothing when the temperature is undefined", () => {
    expect(resolveRunTemperature({ entry: testEntry("m", false), temperature: undefined })).toEqual(
      { ignored: false },
    )
  })
})

describe("startRunTemperature", () => {
  it("prefers the run option, consumes pending, and resets the flag", () => {
    expect(startRunTemperature(0.5, 0.9)).toEqual({
      value: 0.5,
      pending: undefined,
      reported: false,
    })
    expect(startRunTemperature(undefined, 0.9)).toEqual({
      value: 0.9,
      pending: undefined,
      reported: false,
    })
    expect(emptyRunTemperature()).toEqual({ value: undefined, pending: undefined, reported: false })
  })
})

describe("runTemperatureOption and lookupModelEntry", () => {
  afterEach(() => clearModelRegistry())

  it("finds the provider-scoped entry, and none for an unknown model", () => {
    registerModel(testEntry("t-accepts", true))
    expect(lookupModelEntry("t-accepts", "test-provider")?.id).toBe("t-accepts")
    expect(lookupModelEntry("t-accepts")?.id).toBe("t-accepts")
    expect(lookupModelEntry("t-unknown", "test-provider")).toBeUndefined()
  })

  it("returns the temperature for an accepting model without a warn", () => {
    registerModel(testEntry("t-accepts", true))
    const { diagnostics, warns } = fakeDiagnostics()
    const state = startRunTemperature(0.2, undefined)
    expect(runTemperatureOption(state, "t-accepts", "test-provider", diagnostics)).toEqual({
      temperature: 0.2,
    })
    expect(warns).toEqual([])
  })

  it("drops the value for acceptsTemperature false and warns once per run", () => {
    registerModel(testEntry("t-rejects", false))
    const { diagnostics, warns } = fakeDiagnostics()
    const state = startRunTemperature(0.2, undefined)
    expect(runTemperatureOption(state, "t-rejects", "test-provider", diagnostics)).toEqual({})
    expect(runTemperatureOption(state, "t-rejects", "test-provider", diagnostics)).toEqual({})
    expect(warns).toHaveLength(1)
    expect(warns[0]?.[0]).toBe("agent.temperature-ignored")
    expect(state.reported).toBe(true)
  })

  it("sends the value for a model with no registry entry", () => {
    const { diagnostics, warns } = fakeDiagnostics()
    const state = startRunTemperature(1, undefined)
    expect(runTemperatureOption(state, "t-unknown", undefined, diagnostics)).toEqual({
      temperature: 1,
    })
    expect(warns).toEqual([])
  })

  it("returns nothing when the run has no temperature", () => {
    registerModel(testEntry("t-rejects", false))
    const { diagnostics, warns } = fakeDiagnostics()
    const state = emptyRunTemperature()
    expect(runTemperatureOption(state, "t-rejects", "test-provider", diagnostics)).toEqual({})
    expect(warns).toEqual([])
  })

  it("resolveMaxOutputTokens returns undefined for an unknown model", () => {
    expect(resolveMaxOutputTokens("t-unknown", undefined, [])).toBeUndefined()
  })
})

describe("resolveMaxOutputTokens clamp (shared context window)", () => {
  afterEach(() => clearModelRegistry())

  function sharedWindowEntry(id: string, providerId: string, estimate?: number): ModelEntry {
    const base = testEntry(id, true)
    return {
      ...base,
      providerId,
      capabilities: {
        ...base.capabilities,
        contextWindow: 200_000,
        maxOutputTokens: 100_000,
        outputTokensShareContextWindow: true,
      },
      ...(estimate ? { estimateTokens: makeCharRatioEstimator(estimate) } : {}),
    }
  }

  it("with no estimator, uses the UTF-8 byte count as the input upper bound", () => {
    registerModel(sharedWindowEntry("t-shared", "p-none"))
    // 50_000 CJK chars = 150_000 UTF-8 bytes (3 bytes each). A chars ratio
    // would under-count it; the byte bound cannot.
    const messages = [{ role: "user" as const, content: "日".repeat(50_000) }]
    expect(resolveMaxOutputTokens("t-shared", "p-none", messages)).toBe(
      200_000 - 150_000 - DEFAULT_OUTPUT_SAFETY_MARGIN,
    )
  })

  it("uses the provider-scoped estimator when the provider set one", () => {
    registerModel(sharedWindowEntry("t-shared", "p-est", 4))
    const messages = [{ role: "user" as const, content: "x".repeat(400_000) }]
    // 400_000 / 4 = 100_000 input tokens -> 100_000 - margin left.
    expect(resolveMaxOutputTokens("t-shared", "p-est", messages)).toBe(
      100_000 - DEFAULT_OUTPUT_SAFETY_MARGIN,
    )
  })

  it("does not take the estimator of another provider for the same id", () => {
    registerModel(sharedWindowEntry("t-shared", "p-est", 1_000))
    registerModel(sharedWindowEntry("t-shared", "p-none"))
    const messages = [{ role: "user" as const, content: "x".repeat(100_000) }]
    // p-none has no estimator: bytes (100_000), not 100_000 / 1_000.
    expect(resolveMaxOutputTokens("t-shared", "p-none", messages)).toBe(
      100_000 - DEFAULT_OUTPUT_SAFETY_MARGIN,
    )
  })
})

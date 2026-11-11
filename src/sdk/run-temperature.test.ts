import { afterEach, describe, expect, it } from "bun:test"

import { defaultCapabilities } from "../llm/capabilities.ts"
import { clearModelRegistry, type ModelEntry, registerModel } from "../llm/model-registry.ts"

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

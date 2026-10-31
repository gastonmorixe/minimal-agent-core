import { beforeEach, describe, expect, it } from "bun:test"

import { PROVIDER_TOKEN_RE } from "../architecture/provider-scan.ts"

import {
  clearModelRegistry,
  clearProviderRegistry,
  getDefaultModelId,
  setDefaultModelId,
} from "./model-registry.ts"
import { clearProviderPlugins } from "./provider-plugin.ts"
import { registerTestProvider } from "./test-fixtures.ts"

/**
 * C-1 (Wave C, PLAN.md): the no-model default must come from the model
 * registry, not a hardcoded provider SKU. A provider (or config) may declare
 * the registry default; absent one, the registry falls back to the first
 * registered model. Core code names no provider token (the provider scan
 * covers every core file).
 */
describe("C-1: default model is registry-derived", () => {
  beforeEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  it("getDefaultModelId returns the explicitly declared registry default", () => {
    registerTestProvider({ models: [{ id: "test-model-1" }, { id: "test-model-2" }] })
    setDefaultModelId("test-model-2")
    expect(getDefaultModelId()).toBe("test-model-2")
  })

  it("getDefaultModelId falls back to the first registered model when no default declared", () => {
    registerTestProvider({ models: [{ id: "test-model-1" }, { id: "test-model-2" }] })
    expect(getDefaultModelId()).toBe("test-model-1")
  })

  it("getDefaultModelId yields a provider-free id when the registry is empty", () => {
    const id = getDefaultModelId()
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
    // The empty-registry fallback must NOT be a provider literal.
    expect(PROVIDER_TOKEN_RE.test(id)).toBe(false)
  })
})

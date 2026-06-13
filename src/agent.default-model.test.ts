import { readFileSync } from "node:fs"

import { beforeEach, describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import { PROVIDER_TOKEN_RE, stripComments } from "./architecture/provider-scan.ts"
import type { AuthResult } from "./auth.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  getDefaultModelId,
  setDefaultModelId,
} from "./llm/model-registry.ts"
import { clearProviderPlugins } from "./llm/provider-plugin.ts"
import { registerTestProvider } from "./llm/test-fixtures.ts"

/**
 * C-1 (Wave C, PLAN.md): the agent's no-model default must come from the
 * model registry, not a hardcoded provider SKU. A provider (or config) may
 * declare the registry default; absent one, the registry falls back to the
 * first registered model. Core code names no provider token.
 */
describe("C-1: agent default model is registry-derived", () => {
  const auth: AuthResult = { type: "api-key", token: "test-token" }

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

  it("new Agent({auth}) with no model boots using the registry default", () => {
    registerTestProvider({ models: [{ id: "test-model-1" }, { id: "test-model-2" }] })
    setDefaultModelId("test-model-2")
    const agent = new Agent({ auth })
    expect(agent.getModel()).toBe("test-model-2")
  })

  it("new Agent({auth}) falls back to the first registered model with no default", () => {
    registerTestProvider({ models: [{ id: "test-model-1" }] })
    const agent = new Agent({ auth })
    expect(agent.getModel()).toBe("test-model-1")
  })

  it("src/agent.ts contains no provider-token literal in CODE", () => {
    const code = stripComments(readFileSync(new URL("./agent.ts", import.meta.url), "utf8"))
    expect(PROVIDER_TOKEN_RE.test(code)).toBe(false)
  })
})

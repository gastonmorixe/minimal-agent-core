import { readFileSync } from "node:fs"

import { beforeEach, describe, expect, it } from "bun:test"

import { PROVIDER_TOKEN_RE, stripComments } from "../architecture/provider-scan.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  setDefaultModelId,
} from "../llm/model-registry.ts"
import {
  clearProviderPlugins,
  type ProviderPlugin,
  registerProviderPlugin,
} from "../llm/provider-plugin.ts"
import { registerTestProvider } from "../llm/test-fixtures.ts"

import {
  modelHidesReasoning,
  providerWantsQuotaProbe,
  signInStepLabel,
} from "./provider-presentation.ts"

/**
 * C-2 (Wave C, PLAN.md): the startup banner / welcome-card decisions that
 * USED to hardcode provider tokens (`"Anthropic (Claude)"`, `includes("haiku")`,
 * `providerId !== "anthropic"`) now read provider-supplied data + capability
 * flags. This module owns those three pure decisions so index.ts names no
 * provider.
 */
describe("C-2: provider-presentation seams", () => {
  beforeEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  describe("signInStepLabel", () => {
    it("uses the default provider's declared displayName", () => {
      registerTestProvider({ displayName: "Acme Models", models: [{ id: "test-model-1" }] })
      setDefaultModelId("test-model-1")
      const label = signInStepLabel()
      expect(label).toContain("Acme Models")
      expect(label.toLowerCase()).toContain("sign in")
    })

    it("falls back to a neutral, provider-free label with no provider registered", () => {
      const label = signInStepLabel()
      expect(label.toLowerCase()).toContain("sign in")
      expect(PROVIDER_TOKEN_RE.test(label)).toBe(false)
    })
  })

  describe("modelHidesReasoning", () => {
    it("is true for a model that supports neither thinking nor effort", () => {
      registerTestProvider({
        models: [{ id: "test-cheap-1", capabilities: { effort: { levels: [] } } }],
      })
      expect(modelHidesReasoning("test-cheap-1")).toBe(true)
    })

    it("is false for a model that supports adaptive thinking", () => {
      registerTestProvider({
        models: [{ id: "test-think-1", capabilities: { thinking: { adaptive: true } } }],
      })
      expect(modelHidesReasoning("test-think-1")).toBe(false)
    })

    it("is false for a model that supports effort levels", () => {
      registerTestProvider({
        models: [{ id: "test-effort-1", capabilities: { effort: { levels: ["low", "medium"] } } }],
      })
      expect(modelHidesReasoning("test-effort-1")).toBe(false)
    })

    it("is false (show the rows) for an unknown model id", () => {
      expect(modelHidesReasoning("totally-unregistered")).toBe(false)
    })
  })

  describe("providerWantsQuotaProbe", () => {
    it("is true when the provider declares a startup quota-probe seam", () => {
      const plugin: ProviderPlugin = {
        id: "with-probe",
        displayName: "With Probe",
        shortCode: "wp",
        register() {},
        async primeSessionInfo() {},
      }
      registerProviderPlugin(plugin)
      expect(providerWantsQuotaProbe("with-probe")).toBe(true)
    })

    it("is false when the provider declares no quota-probe seam", () => {
      registerTestProvider({ id: "no-probe", models: [{ id: "test-model-1" }] })
      expect(providerWantsQuotaProbe("no-probe")).toBe(false)
    })

    it("is false for an undefined / unknown provider id", () => {
      expect(providerWantsQuotaProbe(undefined)).toBe(false)
      expect(providerWantsQuotaProbe("nope")).toBe(false)
    })
  })

  it("src/startup/provider-presentation.ts contains no provider-token literal in CODE", () => {
    const code = stripComments(
      readFileSync(new URL("./provider-presentation.ts", import.meta.url), "utf8"),
    )
    expect(PROVIDER_TOKEN_RE.test(code)).toBe(false)
  })
})

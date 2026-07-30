import { afterEach, describe, expect, it } from "bun:test"

import { defaultAuthStore, resetDefaultAuthStoreForTests } from "../../auth/auth-store.ts"
import { clearModelRegistry, clearProviderRegistry } from "../../llm/model-registry.ts"
import { clearProviderPlugins, registerProviderPlugin } from "../../llm/provider-plugin.ts"
import { registerTestProvider } from "../../llm/test-fixtures.ts"
import { stripAnsi } from "../../terminal/term-width.ts"

import { runListModelsLiveCommand } from "./list-models-live.ts"

describe("list-models-live", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    resetDefaultAuthStoreForTests()
  })

  it("merges live rows and never calls foreign hooks when filtered", async () => {
    let otherHookCalls = 0
    let targetHookCalls = 0
    registerTestProvider({
      id: "target",
      displayName: "Target",
      models: [{ id: "target-auto", displayName: "Auto" }],
    })
    registerProviderPlugin({
      id: "other",
      displayName: "Other",
      shortCode: "ot",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        otherHookCalls++
        throw new Error("Models API 401: OAuth access token has been revoked.")
      },
    })
    registerProviderPlugin({
      id: "target",
      displayName: "Target",
      shortCode: "tgt",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        targetHookCalls++
        return [{ id: "target-live", displayName: "Live Only", createdAt: "2026-01-01" }]
      },
    })

    let out = ""
    let err = ""
    await runListModelsLiveCommand("target", {
      output: { write: (s) => (out += s) },
      error: { write: (s) => (err += s) },
    })
    const stripped = stripAnsi(out + err)

    expect(targetHookCalls).toBe(1)
    expect(otherHookCalls).toBe(0)
    expect(stripped).toContain("target-auto")
    expect(stripped).toContain("target-live")
    expect(stripped).not.toContain("live model list unavailable")
    expect(stripped).not.toContain("revoked")
  })

  it("lists a publicModelList provider without a stored credential", async () => {
    let sawAuthKind: string | undefined
    registerProviderPlugin({
      id: "pub",
      displayName: "Public Gateway",
      shortCode: "pub",
      register() {},
      publicModelList: true,
      async listLiveModels(auth) {
        sawAuthKind = auth.kind
        return [{ id: "pub-live-model", displayName: "Pub Live", createdAt: "2026-02-02" }]
      },
    })

    let out = ""
    await runListModelsLiveCommand("pub", { output: { write: (s) => (out += s) } })
    const stripped = stripAnsi(out)

    expect(sawAuthKind).toBe("custom")
    expect(stripped).toContain("pub-live-model")
    expect(stripped).toContain("Pub Live")
    expect(stripped).toContain("1 models available")
  })

  it("skips auth-required live catalogs without a credential", async () => {
    let hookCalled = false
    registerProviderPlugin({
      id: "priv",
      displayName: "Private Provider",
      shortCode: "prv",
      register() {},
      async listLiveModels() {
        hookCalled = true
        return [{ id: "priv-live-model" }]
      },
    })

    let out = ""
    await runListModelsLiveCommand("priv", { output: { write: (s) => (out += s) } })
    const stripped = stripAnsi(out)

    expect(hookCalled).toBe(false)
    expect(stripped).not.toContain("priv-live-model")
    expect(stripped).toContain('no models registered for provider "priv"')
  })

  it("enriches live rows from matching static registry entries only", async () => {
    registerTestProvider({
      id: "live",
      displayName: "Live",
      models: [
        {
          id: "live-model",
          displayName: "Static Name",
          capabilities: { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
        },
      ],
    })
    registerProviderPlugin({
      id: "live",
      displayName: "Live",
      shortCode: "li",
      register() {},
      apiKeyAuth: {
        serviceId: "live",
        displayName: "Live",
        buildCredential: (key) => ({
          serviceId: "live",
          displayName: "Live",
          secrets: { apiKey: key },
        }),
        readApiKey: (secrets) => (typeof secrets.apiKey === "string" ? secrets.apiKey : null),
      },
      async listLiveModels() {
        return [{ id: "live-model", displayName: "Live Name", createdAt: "2026-01-01" }]
      },
    })
    defaultAuthStore().set("live", "Live", { apiKey: "dummy" })

    let out = ""
    await runListModelsLiveCommand(undefined, {
      columns: 220,
      output: { write: (s) => (out += s) },
    })
    const stripped = stripAnsi(out)
    expect(stripped).toContain("live-model")
    expect(stripped).toContain("Live Name")
    expect(stripped).toContain("ctx 1.05M")
    expect(stripped).toContain("cutoff:2026-01-01")
  })
})

/**
 * `llm:complete` capability (Wave G).
 *
 * Verifies the host factory grants `ctx.host.llm` ONLY when declared. The
 * completion path itself (provider auth + canonicalSendFn + drain) is exercised
 * end-to-end by the memory plugin's own summarize tests against injected
 * doubles; here we pin the grant-gating + the method shape, which is the
 * seam's contract.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { defaultAuthStore, resetDefaultAuthStoreForTests } from "../../auth/auth-store.ts"
import { clearModelRegistry, clearProviderRegistry } from "../../llm/model-registry.ts"
import type { ProviderAuth } from "../../llm/provider.ts"
import { clearProviderPlugins } from "../../llm/provider-plugin.ts"
import { registerTestProvider } from "../../llm/test-fixtures.ts"

import { buildPluginHost } from "./factory.ts"

describe("plugin host: llm:complete capability", () => {
  it("is undefined when not granted (deny-by-default)", () => {
    const host = buildPluginHost({ capabilities: [] })
    expect(host.llm).toBeUndefined()
  })

  it("llm:complete populates host.llm with a complete() method", () => {
    const host = buildPluginHost({ capabilities: ["llm:complete"] })
    expect(host.llm).toBeDefined()
    expect(typeof host.llm?.complete).toBe("function")
  })

  it("is independent of the other capability grants", () => {
    const host = buildPluginHost({ capabilities: ["models:read", "session-info:read"] })
    // llm not requested → absent even though sibling capabilities are present.
    expect(host.llm).toBeUndefined()
    expect(host.models).toBeDefined()
    expect(host.sessionInfo).toBeDefined()
  })
})

describe("plugin host: llm.complete resolves the model's provider (decision 39)", () => {
  let dir: string
  const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
  const prevTestAuth = process.env.MINIMAL_AGENT_TEST_AUTH
  let seenAuth: ProviderAuth | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-llm-complete-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    delete process.env.MINIMAL_AGENT_TEST_AUTH
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    seenAuth = undefined
    const handle = registerTestProvider({
      id: "llm-complete-prov",
      models: [{ id: "llm-complete-model" }],
      apiKeyAuth: {
        serviceId: "llm-complete-api",
        displayName: "LLM Complete Key",
        buildCredential: (apiKey: string) => ({
          serviceId: "llm-complete-api",
          displayName: "LLM Complete Key",
          secrets: { tokenType: "api-key", apiKey },
        }),
        readApiKey: (secrets: Record<string, unknown>) =>
          typeof secrets.apiKey === "string" ? secrets.apiKey : null,
      },
    })
    handle.adapter.run = async function* (_req, _model, ctx) {
      seenAuth = ctx.auth
      yield { type: "text_delta", index: 0, text: "summary-ok" }
      yield { type: "message_stop" }
    }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
    else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
    if (prevTestAuth === undefined) delete process.env.MINIMAL_AGENT_TEST_AUTH
    else process.env.MINIMAL_AGENT_TEST_AUTH = prevTestAuth
  })

  it("uses the stored credential of the model's provider, with no plan OAuth entry", async () => {
    defaultAuthStore().set("llm-complete-api", "LLM Complete Key", {
      tokenType: "api-key",
      apiKey: "sk-llm-complete",
    })
    const host = buildPluginHost({ capabilities: ["llm:complete"] })
    const text = await host.llm?.complete({
      model: "llm-complete-model",
      system: "sys",
      userText: "hi",
    })
    expect(text).toBe("summary-ok")
    expect(seenAuth).toEqual({ kind: "api-key", key: "sk-llm-complete" })
  })

  it("rejects with a login hint for the model's provider when it has no credential", async () => {
    const host = buildPluginHost({ capabilities: ["llm:complete"] })
    const run = host.llm?.complete({ model: "llm-complete-model", system: "s", userText: "u" })
    await expect(run).rejects.toMatchObject({
      kind: "NoProviderCredentialsError",
      providerId: "llm-complete-prov",
    })
    expect(seenAuth).toBeUndefined()
  })

  it("rejects an unknown model before any provider runs", async () => {
    const host = buildPluginHost({ capabilities: ["llm:complete"] })
    const run = host.llm?.complete({ model: "no-such-model", system: "s", userText: "u" })
    await expect(run).rejects.toThrow(/unknown model "no-such-model"/)
    expect(seenAuth).toBeUndefined()
  })
})

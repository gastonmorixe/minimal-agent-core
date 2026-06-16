import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { defaultAuthStore, resetDefaultAuthStoreForTests } from "./auth-store.ts"
import {
  clearProviderCredentials,
  discoverCredentialedProviders,
  storedProvidersHint,
  tryResolveProviderAuth,
} from "./auth-strategies.ts"
import { clearModelRegistry, clearProviderRegistry, registerModel } from "./llm/model-registry.ts"
import {
  type ApiKeyAuthProvider,
  clearProviderPlugins,
  registerProviderPlugin,
} from "./llm/provider-plugin.ts"

const TEST_API_KEY_AUTH: ApiKeyAuthProvider = {
  serviceId: "test-api-key",
  displayName: "Test API Key",
  buildCredential: (apiKey: string) => ({
    serviceId: "test-api-key",
    displayName: "Test API Key",
    secrets: { tokenType: "api-key", apiKey },
  }),
  readApiKey: (secrets: Record<string, unknown>) =>
    typeof secrets.apiKey === "string" ? secrets.apiKey : null,
}

function registerTestOpenRouterLikePlugin(): void {
  registerProviderPlugin({
    id: "test-provider",
    displayName: "Test Provider",
    shortCode: "or",
    register() {},
    apiKeyAuth: TEST_API_KEY_AUTH,
  })
  registerModel({
    id: "auth-test-model",
    providerId: "test-provider",
    surfaceId: "test-surface",
    tags: [],
    capabilities: { modalities: ["text"] },
  } as any)
  registerModel({
    id: "test-provider/test-model-2",
    providerId: "test-provider",
    surfaceId: "test-surface",
    tags: ["cheap"],
    capabilities: { modalities: ["text"] },
  } as any)
}

describe("auth-strategies", () => {
  let dir: string
  const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
  const prevConfig = process.env.MINIMAL_AGENT_CONFIG
  const prevEnvKey = process.env.TEST_PROVIDER_KEY

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-auth-strategies-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    process.env.MINIMAL_AGENT_CONFIG = join(dir, "config.jsonc")
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    delete process.env.TEST_PROVIDER_KEY
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    resetDefaultAuthStoreForTests()
    if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
    else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
    if (prevConfig === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevConfig
    if (prevEnvKey === undefined) delete process.env.TEST_PROVIDER_KEY
    else process.env.TEST_PROVIDER_KEY = prevEnvKey
  })

  it("discovers stored API-key credentials by plugin service id", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Test API Key", {
      tokenType: "api-key",
      apiKey: "sk-or",
    })

    const found = discoverCredentialedProviders()
    expect(found).toHaveLength(1)
    expect(found[0]?.providerId).toBe("test-provider")
    expect(found[0]?.source).toBe("store")
  })

  it("reports unreadable stored credentials instead of hiding them", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Test API Key", {
      tokenType: "api-key",
    })

    const found = discoverCredentialedProviders()
    expect(found).toHaveLength(1)
    expect(found[0]?.providerId).toBe("test-provider")
    expect(found[0]?.credentialInfo).toEqual({ usable: false })
  })

  it("resolves auth from the auth store even when env and config contain keys", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Test API Key", {
      tokenType: "api-key",
      apiKey: "sk-store",
    })
    process.env.TEST_PROVIDER_KEY = "sk-env"
    writeFileSync(
      process.env.MINIMAL_AGENT_CONFIG!,
      JSON.stringify({ apiKeys: { "test-provider": "sk-config" } }),
    )

    const auth = tryResolveProviderAuth("test-provider", "auth-test-model")
    expect(auth?.kind).toBe("api-key")
    if (auth?.kind === "api-key") expect(auth.key).toBe("sk-store")
  })

  it("ignores env and config keys when the auth store is empty", () => {
    registerTestOpenRouterLikePlugin()
    process.env.TEST_PROVIDER_KEY = "sk-env"
    writeFileSync(
      process.env.MINIMAL_AGENT_CONFIG!,
      JSON.stringify({ apiKeys: { "test-provider": "sk-config" } }),
    )

    expect(tryResolveProviderAuth("test-provider", "auth-test-model")).toBeNull()
    expect(discoverCredentialedProviders()).toEqual([])
  })

  it("storedProvidersHint lists credentialed providers and example models", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Test API Key", {
      tokenType: "api-key",
      apiKey: "sk-or",
    })

    const hint = storedProvidersHint()
    expect(hint).toContain("test-provider")
    expect(hint).toContain("test-provider/test-model-2")
    expect(hint).toContain("config.jsonc")
  })

  it("clearProviderCredentials removes a provider's store entry", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Test API Key", {
      tokenType: "api-key",
      apiKey: "sk-or",
    })
    expect(clearProviderCredentials("test-provider")).toBe(true)
    expect(discoverCredentialedProviders()).toHaveLength(0)
  })
})

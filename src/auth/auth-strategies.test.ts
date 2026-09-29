import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { clearModelRegistry, clearProviderRegistry, registerModel } from "../llm/model-registry.ts"
import {
  type ApiKeyAuthProvider,
  type AuthCredentialInfo,
  clearProviderPlugins,
  registerProviderPlugin,
} from "../llm/provider-plugin.ts"

import { defaultAuthStore, resetDefaultAuthStoreForTests } from "./auth-store.ts"
import {
  clearProviderCredentials,
  discoverCredentialedProviders,
  resolveStoredProviderAuth,
  storedProvidersHint,
  tryResolveProviderAuth,
} from "./auth-strategies.ts"

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

  // ── Multi-credential tests ──────────────────────────────────────────────

  it("discovers multiple credentials per provider with different names", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Test API Key", {
      tokenType: "api-key",
      apiKey: "sk-default",
    })
    defaultAuthStore().set("test-api-key", "Work", {
      tokenType: "api-key",
      apiKey: "sk-work",
    })
    defaultAuthStore().set("test-api-key", "Personal", {
      tokenType: "api-key",
      apiKey: "sk-personal",
    })

    const found = discoverCredentialedProviders()
    expect(found).toHaveLength(3)
    expect(found.map((f) => f.credentialName)).toEqual(
      expect.arrayContaining(["Test API Key", "Work", "Personal"]),
    )
    expect(found.every((f) => f.providerId === "test-provider")).toBe(true)
  })

  it("resolves auth by credentialName when multiple credentials exist", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Test API Key", {
      tokenType: "api-key",
      apiKey: "sk-default",
    })
    defaultAuthStore().set("test-api-key", "Work", {
      tokenType: "api-key",
      apiKey: "sk-work",
    })

    // Without credentialName, uses the default displayName
    const defaultAuth = tryResolveProviderAuth("test-provider")
    expect(defaultAuth).not.toBeNull()
    if (defaultAuth?.kind === "api-key") expect(defaultAuth.key).toBe("sk-default")

    // With credentialName, resolves the named entry
    const workAuth = tryResolveProviderAuth("test-provider", "", "Work")
    expect(workAuth).not.toBeNull()
    if (workAuth?.kind === "api-key") expect(workAuth.key).toBe("sk-work")

    // Non-existent credentialName returns null
    const missingAuth = tryResolveProviderAuth("test-provider", "", "NonExistent")
    expect(missingAuth).toBeNull()
  })

  it("clearProviderCredentials with credentialName removes only that entry", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Test API Key", {
      tokenType: "api-key",
      apiKey: "sk-default",
    })
    defaultAuthStore().set("test-api-key", "Work", {
      tokenType: "api-key",
      apiKey: "sk-work",
    })

    expect(clearProviderCredentials("test-provider", defaultAuthStore(), "Work")).toBe(true)
    const remaining = discoverCredentialedProviders()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.credentialName).toBe("Test API Key")
  })

  it("storedProvidersHint shows all credential names per provider", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Test API Key", {
      tokenType: "api-key",
      apiKey: "sk-default",
    })
    defaultAuthStore().set("test-api-key", "Work", {
      tokenType: "api-key",
      apiKey: "sk-work",
    })

    const hint = storedProvidersHint()
    expect(hint).toContain("Test API Key")
    expect(hint).toContain("Work")
  })

  it("resolveStoredProviderAuth resolves the named credential when given", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Test API Key", {
      tokenType: "api-key",
      apiKey: "sk-default",
    })
    defaultAuthStore().set("test-api-key", "Work", {
      tokenType: "api-key",
      apiKey: "sk-work",
    })

    // No credentialName → default displayName entry
    const def = resolveStoredProviderAuth("test-provider", "auth-test-model")
    expect(def.kind).toBe("api-key")
    if (def.kind === "api-key") expect(def.key).toBe("sk-default")

    // Explicit credentialName → the named entry
    const work = resolveStoredProviderAuth("test-provider", "auth-test-model", "Work")
    expect(work.kind).toBe("api-key")
    if (work.kind === "api-key") expect(work.key).toBe("sk-work")
  })

  it("discovers both oauth and api-key credentials when a plugin has both strategies", () => {
    registerProviderPlugin({
      id: "dual-auth-provider",
      displayName: "Dual Auth Provider",
      shortCode: "da",
      register() {},
      oauthLogin: {
        serviceId: "dual-oauth",
        displayName: "Dual OAuth",
        config: () => ({
          clientId: "c",
          authorizeUrl: "a",
          tokenUrl: "t",
          redirectUri: "r",
          scopes: [],
        }),
        buildCredential: () => ({
          credential: { serviceId: "dual-oauth", displayName: "Dual OAuth", secrets: {} },
          result: { accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] },
        }),
        readAuth: (secrets) =>
          typeof secrets.accessToken === "string"
            ? { kind: "oauth", token: secrets.accessToken }
            : null,
      },
      apiKeyAuth: {
        serviceId: "dual-api-key",
        displayName: "Dual API Key",
        buildCredential: (key) => ({
          serviceId: "dual-api-key",
          displayName: "Dual API Key",
          secrets: { tokenType: "api-key", apiKey: key },
        }),
        readApiKey: (secrets) => (typeof secrets.apiKey === "string" ? secrets.apiKey : null),
      },
    })

    defaultAuthStore().set("dual-oauth", "Dual OAuth", { tokenType: "oauth", accessToken: "at" })
    defaultAuthStore().set("dual-api-key", "Dual API Key", {
      tokenType: "api-key",
      apiKey: "sk-dual",
    })

    const found = discoverCredentialedProviders()
    expect(found).toHaveLength(2)

    const oauth = found.find((f) => f.authKind === "oauth")
    expect(oauth).toBeDefined()
    expect(oauth!.providerId).toBe("dual-auth-provider")
    expect(oauth!.credentialLabel).toBe("Dual OAuth")

    const apiKey = found.find((f) => f.authKind === "api-key")
    expect(apiKey).toBeDefined()
    expect(apiKey!.providerId).toBe("dual-auth-provider")
    expect(apiKey!.credentialLabel).toBe("Dual API Key")
  })

  for (const kind of ["oauth", "api-key"] as const) {
    for (const withInspect of [false, true]) {
      it(`merges safe saved metadata for ${kind} with inspect=${withInspect}`, () => {
        const providerInfo: AuthCredentialInfo = {
          usable: false,
          label: "Provider label",
          expiresAt: 123,
          hasRefreshToken: true,
          accountId: "provider-account",
          organizationId: "provider-org",
          scopes: ["read"],
          details: [
            { key: "emailAddress", label: "Provider email", value: "provider@example.com" },
            { key: "custom", label: "Custom", value: "preserved" },
          ],
        }
        const inspectCredential = withInspect ? () => providerInfo : undefined
        registerProviderPlugin({
          id: "metadata-provider",
          displayName: "Metadata Provider",
          shortCode: "mp",
          register() {},
          ...(kind === "api-key"
            ? { apiKeyAuth: { ...TEST_API_KEY_AUTH, inspectCredential } }
            : {
                oauthLogin: {
                  serviceId: "test-api-key",
                  displayName: "Test OAuth",
                  config: () => ({
                    clientId: "c",
                    authorizeUrl: "a",
                    tokenUrl: "t",
                    redirectUri: "r",
                    scopes: [],
                  }),
                  buildCredential: () => ({
                    credential: {
                      serviceId: "test-api-key",
                      displayName: "Test OAuth",
                      secrets: {},
                    },
                    result: { accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] },
                  }),
                  readAuth: () => ({ kind: "oauth" as const, token: "runtime-secret" }),
                  inspectCredential,
                },
              }),
        })
        defaultAuthStore().set("test-api-key", "Saved", {
          apiKey: "secret-key",
          token: "secret-token",
          password: "secret-password",
          accessToken: "secret-access",
          refreshToken: "secret-refresh",
          idToken: "secret-jwt",
          emailAddress: "saved@example.com",
          account_id: "saved-account",
          orgId: "saved-org",
          profile: { userName: "saved-user", displayName: "Saved Name", password: "nested-secret" },
          user: { user_id: "saved-user-id", token: "nested-token" },
          subscription: { tier: "Pro", apiKey: "nested-key" },
          arbitrary: { email: "hidden@example.com" },
        })
        const info = discoverCredentialedProviders()[0]?.credentialInfo
        expect(info).toEqual({
          ...(withInspect ? providerInfo : { usable: true }),
          accountId: withInspect ? "provider-account" : "saved-account",
          organizationId: withInspect ? "provider-org" : "saved-org",
          details: [
            ...(withInspect
              ? providerInfo.details!
              : [{ key: "email", label: "email", value: "saved@example.com" }]),
            { key: "username", label: "username", value: "saved-user" },
            { key: "name", label: "name", value: "Saved Name" },
            { key: "userId", label: "user id", value: "saved-user-id" },
            { key: "plan", label: "plan", value: "Pro" },
          ],
        })
        expect(providerInfo.details).toHaveLength(2)
        expect(JSON.stringify(info)).not.toContain("secret")
        expect(JSON.stringify(info)).not.toContain("hidden@example.com")
        defaultAuthStore().set("test-api-key", "Empty", { apiKey: "key" })
        expect(
          discoverCredentialedProviders().find((row) => row.credentialName === "Empty")
            ?.credentialInfo,
        ).toEqual(withInspect ? providerInfo : { usable: true })
      })
    }
  }

  it("reads only explicit scalar identity fields from nested saved accounts", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Nested", {
      apiKey: "secret",
      email: { token: "secret" },
      username: ["not-a-name"],
      name: " ",
      account: { email: "nested@example.com", accountId: "account-1", planType: "Team" },
      profile: { name: "Nested Name" },
      user: { userId: "user-1" },
    })
    expect(discoverCredentialedProviders()[0]?.credentialInfo).toEqual({
      usable: true,
      accountId: "account-1",
      details: [
        { key: "email", label: "email", value: "nested@example.com" },
        { key: "name", label: "name", value: "Nested Name" },
        { key: "userId", label: "user id", value: "user-1" },
        { key: "plan", label: "plan", value: "Team" },
      ],
    })
  })

  it("shows allowlisted saved profile fields without secrets or recursive bags", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Profile A", {
      apiKey: "secret-key",
      givenName: "Ada",
      familyName: "Lovelace",
      xUserId: "x-1",
      planStatus: "active",
      planProvider: "stripe",
      billingPeriodEnd: 1800000000,
      emailVerified: true,
      fedramp: false,
      accessToken: "secret-access",
      arbitrary: { principalId: "hidden-principal" },
    })
    defaultAuthStore().set("test-api-key", "Profile B", {
      apiKey: "secret-key",
      principalId: "meta-1",
      subsTierId: "tier-1",
      subsTierName: "Pro",
      isSubsActive: false,
      emailVerified: false,
      fedramp: true,
      billingPeriodEnd: "2026-12-01",
      refreshToken: "secret-refresh",
      profile: { user: { givenName: "hidden-name" } },
    })
    const found = discoverCredentialedProviders()
    expect(
      found.find((row) => row.credentialName === "Profile A")?.credentialInfo?.details,
    ).toEqual([
      { key: "givenName", label: "given name", value: "Ada" },
      { key: "familyName", label: "family name", value: "Lovelace" },
      { key: "xUserId", label: "x user id", value: "x-1" },
      { key: "planStatus", label: "plan status", value: "active" },
      { key: "planProvider", label: "plan provider", value: "stripe" },
      { key: "billingPeriodEnd", label: "billing period end", value: "1800000000" },
      { key: "emailVerified", label: "email verified", value: "yes" },
      { key: "fedramp", label: "fedramp", value: "no" },
    ])
    expect(
      found.find((row) => row.credentialName === "Profile B")?.credentialInfo?.details,
    ).toEqual([
      { key: "plan", label: "plan", value: "Pro" },
      { key: "principalId", label: "principal id", value: "meta-1" },
      { key: "billingPeriodEnd", label: "billing period end", value: "2026-12-01" },
      { key: "subsTierId", label: "subscription tier id", value: "tier-1" },
      { key: "isSubsActive", label: "subscription active", value: "no" },
      { key: "emailVerified", label: "email verified", value: "no" },
      { key: "fedramp", label: "fedramp", value: "yes" },
    ])
    const output = JSON.stringify(found.map((row) => row.credentialInfo))
    expect(output).not.toContain("secret")
    expect(output).not.toContain("hidden")
  })

  for (const billingPeriodEnd of [Infinity, NaN, true, {}, []]) {
    it(`rejects invalid billing period end ${String(billingPeriodEnd)} and nonboolean flags`, () => {
      registerTestOpenRouterLikePlugin()
      defaultAuthStore().set("test-api-key", "Invalid", {
        apiKey: "secret",
        billingPeriodEnd,
        isSubsActive: "true",
        emailVerified: 1,
        fedramp: { token: "secret" },
      })
      expect(discoverCredentialedProviders()[0]?.credentialInfo).toEqual({ usable: true })
    })
  }

  it("resolveStoredProviderAuth throws for an unknown credential name", () => {
    registerTestOpenRouterLikePlugin()
    defaultAuthStore().set("test-api-key", "Test API Key", {
      tokenType: "api-key",
      apiKey: "sk-default",
    })

    expect(() =>
      resolveStoredProviderAuth("test-provider", "auth-test-model", "NonExistent"),
    ).toThrow(/no credentials/)
  })
})

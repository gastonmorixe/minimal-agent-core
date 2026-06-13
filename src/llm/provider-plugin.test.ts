import { afterEach, describe, expect, it } from "bun:test"

import {
  findApiKeyAuthProvider,
  findOAuthLoginProvider,
  listApiKeyAuthProviders,
  listOAuthLoginProviders,
} from "../auth-strategies.ts"

import {
  type ApiKeyAuthProvider,
  activateProviderPlugins,
  clearProviderPlugins,
  findProviderPlugin,
  listProviderPlugins,
  type OAuthLoginProvider,
  type ProviderPlugin,
  type ProviderStartupContext,
  registerProviderPlugin,
} from "./provider-plugin.ts"

describe("provider-plugin registry", () => {
  afterEach(() => {
    clearProviderPlugins()
  })

  it("registers, lists, finds, and activates plugins", () => {
    clearProviderPlugins()
    let activated = 0
    const fake: ProviderPlugin = {
      id: "fake",
      displayName: "Fake",
      shortCode: "fk",
      register() {
        activated++
      },
    }
    registerProviderPlugin(fake)
    expect(listProviderPlugins().map((p) => p.id)).toContain("fake")
    expect(findProviderPlugin("fake")?.displayName).toBe("Fake")
    expect(activateProviderPlugins()).toContain("fake")
    expect(activated).toBe(1)
  })

  it("de-dupes by id", () => {
    clearProviderPlugins()
    const make = (displayName: string): ProviderPlugin => ({
      id: "dup",
      displayName,
      shortCode: "d",
      register() {},
    })
    registerProviderPlugin(make("first"))
    registerProviderPlugin(make("second"))
    expect(listProviderPlugins()).toHaveLength(1)
    expect(findProviderPlugin("dup")?.displayName).toBe("second")
  })

  it("onStartupProbe is optional and invoked per plugin (the index.ts seam)", () => {
    // Mirrors the composition-root loop:
    //   for (const p of listProviderPlugins()) p.onStartupProbe?.(ctx)
    // One plugin probes, one omits the hook entirely. The loop must not
    // throw on the omitter, and the prober must see the exact ctx.
    clearProviderPlugins()
    const seen: ProviderStartupContext[] = []
    const prober: ProviderPlugin = {
      id: "prober",
      displayName: "Prober",
      shortCode: "pr",
      register() {},
      onStartupProbe(ctx) {
        seen.push(ctx)
      },
    }
    const silent: ProviderPlugin = {
      id: "silent",
      displayName: "Silent",
      shortCode: "si",
      register() {},
    }
    registerProviderPlugin(prober)
    registerProviderPlugin(silent)

    const ctx: ProviderStartupContext = {
      auth: { kind: "api-key", key: "k" },
      modelId: "some-model",
    }
    expect(() => {
      for (const p of listProviderPlugins()) p.onStartupProbe?.(ctx)
    }).not.toThrow()
    expect(seen).toEqual([ctx])
  })

  it("preserves provider-declared auth strategy hooks", () => {
    const oauthLogin: OAuthLoginProvider = {
      serviceId: "fake-oauth",
      displayName: "Fake OAuth",
      config() {
        return {
          clientId: "client",
          authorizeUrl: "https://example.test/authorize",
          tokenUrl: "https://example.test/token",
          redirectUri: "https://example.test/callback",
          scopes: ["scope"],
        }
      },
      buildCredential() {
        return {
          credential: {
            serviceId: "fake-oauth",
            displayName: "Fake OAuth",
            secrets: { tokenType: "oauth", accessToken: "at" },
          },
          result: {
            accessToken: "at",
            refreshToken: "rt",
            expiresAt: 1,
            scopes: [],
          },
        }
      },
    }
    const apiKeyAuth: ApiKeyAuthProvider = {
      serviceId: "fake-api-key",
      displayName: "Fake API Key",
      envVars: ["FAKE_API_KEY"],
      configKey: "fake",
      buildCredential(apiKey) {
        return {
          serviceId: "fake-api-key",
          displayName: "Fake API Key",
          secrets: { tokenType: "api-key", apiKey },
        }
      },
      readApiKey(secrets) {
        return typeof secrets.apiKey === "string" ? secrets.apiKey : null
      },
    }
    const fake: ProviderPlugin = {
      id: "fake",
      displayName: "Fake",
      shortCode: "fk",
      register() {},
      oauthLogin,
      apiKeyAuth,
    }

    registerProviderPlugin(fake)

    expect(findProviderPlugin("fake")?.oauthLogin).toBe(oauthLogin)
    expect(findProviderPlugin("fake")?.apiKeyAuth).toBe(apiKeyAuth)
    expect(listOAuthLoginProviders()).toEqual([oauthLogin])
    expect(findOAuthLoginProvider()).toBe(oauthLogin)
    expect(findOAuthLoginProvider("fake")).toBe(oauthLogin)
    expect(listApiKeyAuthProviders()).toEqual([{ providerId: "fake", auth: apiKeyAuth }])
    expect(findApiKeyAuthProvider("fake")).toBe(apiKeyAuth)
  })
})

/**
 * Smoke test for the S34 exports-gap `./host/*` cluster A subpaths (Y2's
 * share: auth, llm-registry/session, config, network, cache-ttl).
 *
 * Imports each new subpath by package name — the way an external consumer
 * installing core from git would, never a relative `src/...` path — and
 * asserts the symbols the brief named actually resolve through the package
 * `exports` map. Deeper behavior of each real module is already covered by
 * that module's own test file; this only confirms importability.
 *
 * @module host-public/host-exports.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  ANTHROPIC_PLAN_OAUTH,
  type AuthResult,
  clearCredentials,
  getAuth,
  legacyAuthToProviderAuth,
  writeCredentials,
} from "@minimal-agent/core/host/auth"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  AuthStore,
  defaultAuthStore,
  resetDefaultAuthStoreForTests,
} from "@minimal-agent/core/host/auth-store"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  discoverCredentialedProviders,
  tryResolveProviderAuth,
} from "@minimal-agent/core/host/auth-strategies"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { DEFAULT_CACHE_TTL, resolveCacheTtl } from "@minimal-agent/core/host/cache-ttl"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  loadUserConfig,
  normalizeSubmittedAtStyle,
  type UserConfig,
} from "@minimal-agent/core/host/config"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { resolveEffort, validateEffortForModel } from "@minimal-agent/core/host/effort-resolution"
// biome-ignore lint/correctness/noUndeclaredDependencies: see AGENTS.md "Public package".
import { errorCode, errorHint, fatalErrorFields } from "@minimal-agent/core/host/error-hint"
// biome-ignore lint/correctness/noUndeclaredDependencies: see AGENTS.md "Public package".
import { listLiveModelsForPicker } from "@minimal-agent/core/host/list-models"
// biome-ignore lint/correctness/noUndeclaredDependencies: see AGENTS.md "Public package".
import { modelShortLabel } from "@minimal-agent/core/host/model-label"
// biome-ignore lint/correctness/noUndeclaredDependencies: see AGENTS.md "Public package".
import {
  clearModelRegistry,
  clearProviderRegistry,
  findModel,
} from "@minimal-agent/core/host/model-registry"
// biome-ignore lint/correctness/noUndeclaredDependencies: see AGENTS.md "Public package".
import {
  applyPreferredDnsResultOrder,
  defaultNetworkClient,
} from "@minimal-agent/core/host/network"
// biome-ignore lint/correctness/noUndeclaredDependencies: see AGENTS.md "Public package".
import { generateCodeVerifier, parsePastedCode } from "@minimal-agent/core/host/oauth-login"
// biome-ignore lint/correctness/noUndeclaredDependencies: see AGENTS.md "Public package".
import {
  contextWindowForModel,
  resolveProviderSessionInfo,
} from "@minimal-agent/core/host/provider-session"
// biome-ignore lint/correctness/noUndeclaredDependencies: see AGENTS.md "Public package".
import {
  resolveSystemPromptOverrides,
  SYSTEM_PROMPT_OVERRIDE_KEY_SPECS,
} from "@minimal-agent/core/host/system-prompt-overrides"

describe("host/* exports (S34 cluster A): every subpath resolves", () => {
  it("./host/auth-store", () => {
    expect(typeof AuthStore).toBe("function")
    expect(typeof defaultAuthStore).toBe("function")
    expect(typeof resetDefaultAuthStoreForTests).toBe("function")
  })

  it("./host/auth-strategies", () => {
    expect(typeof discoverCredentialedProviders).toBe("function")
    expect(typeof tryResolveProviderAuth).toBe("function")
    // Array shape only (not emptiness): the provider-plugin registry is a
    // process-wide singleton other test files may have populated.
    expect(Array.isArray(discoverCredentialedProviders())).toBe(true)
  })

  it("./host/auth (plus the folded adapter-legacy function)", () => {
    // Shape-only, deliberately not the literal id/name value: core code
    // (this test included) must not name a provider token (see
    // architecture.provider-decoupling.test.ts).
    expect(typeof ANTHROPIC_PLAN_OAUTH.id).toBe("string")
    expect(ANTHROPIC_PLAN_OAUTH.id.length).toBeGreaterThan(0)
    expect(typeof getAuth).toBe("function")
    expect(typeof clearCredentials).toBe("function")
    expect(typeof writeCredentials).toBe("function")
    const apiKeyAuth: AuthResult = { type: "api-key", token: "smoke-token" }
    expect(legacyAuthToProviderAuth(apiKeyAuth)).toEqual({ kind: "api-key", key: "smoke-token" })
  })

  it("./host/oauth-login", () => {
    expect(typeof generateCodeVerifier()).toBe("string")
    expect(parsePastedCode("")).toEqual({ ok: false, reason: "empty" })
  })

  it("./host/error-hint", () => {
    expect(errorHint(new Error("plain"))).toBeUndefined()
    expect(errorCode({ code: "e_test" })).toBe("e_test")
    expect(fatalErrorFields(new Error("boom"))).toEqual({ message: "boom" })
  })

  it("./host/list-models", async () => {
    // Array shape only, same registry-singleton caveat as auth-strategies above.
    expect(Array.isArray(await listLiveModelsForPicker())).toBe(true)
  })

  it("./host/model-label", () => {
    expect(modelShortLabel("")).toBe("")
  })

  const UNREGISTERED_MODEL_ID = "zzz-host-public-smoke-test-nonexistent-model"

  it("./host/model-registry (incl. test-hygiene resets)", () => {
    expect(typeof clearModelRegistry).toBe("function")
    expect(typeof clearProviderRegistry).toBe("function")
    expect(findModel(UNREGISTERED_MODEL_ID)).toBeUndefined()
  })

  it("./host/provider-session", async () => {
    expect(contextWindowForModel(UNREGISTERED_MODEL_ID)).toBeUndefined()
    expect(await resolveProviderSessionInfo(UNREGISTERED_MODEL_ID)).toEqual({
      contextWindow: undefined,
      modelLabel: modelShortLabel(UNREGISTERED_MODEL_ID),
    })
  })

  it("./host/system-prompt-overrides (plus the folded key-spec table)", () => {
    expect(resolveSystemPromptOverrides()).toEqual({})
    expect(SYSTEM_PROMPT_OVERRIDE_KEY_SPECS.length).toBeGreaterThan(0)
  })

  it("./host/config", () => {
    expect(typeof loadUserConfig).toBe("function")
    expect(normalizeSubmittedAtStyle("off")).toBe("off")
    expect(normalizeSubmittedAtStyle("bogus")).toBeUndefined()
    const sample: UserConfig = {}
    expect(sample).toEqual({})
  })

  it("./host/effort-resolution", () => {
    expect(resolveEffort({})).toEqual({ effort: undefined, source: undefined })
    expect(validateEffortForModel(undefined, [])).toEqual({ ok: true })
  })

  it("./host/network", () => {
    expect(typeof applyPreferredDnsResultOrder).toBe("function")
    expect(defaultNetworkClient).toBeDefined()
  })

  it("./host/cache-ttl", () => {
    expect(resolveCacheTtl({})).toEqual({ ttl: DEFAULT_CACHE_TTL, source: "default" })
  })
})

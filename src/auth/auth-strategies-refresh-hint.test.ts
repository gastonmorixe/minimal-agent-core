/**
 * Regression: when the server rejects a stored refresh token
 * (`invalid_grant`, e.g. "Refresh token expired"), the error must tell the
 * user the exact command that fixes THIS credential slot.
 *
 * Field symptom (session 1ad23df0, 2026-10-15): credential
 * `anthropic-plan-oauth-5` was last refreshed 4 days earlier. The refresh
 * failed with a raw "Anthropic OAuth refresh failed (400)" invalid_grant
 * error and no next step.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { clearModelRegistry, clearProviderRegistry } from "../llm/model-registry.ts"
import { clearProviderPlugins, type OAuthLoginProvider } from "../llm/provider-plugin.ts"
import { registerTestProvider } from "../llm/test-fixtures.ts"

import { defaultAuthStore, resetDefaultAuthStoreForTests } from "./auth-store.ts"
import { tryResolveProviderAuth } from "./auth-strategies.ts"

const SERVICE = "hint-oauth-svc"

describe("stored OAuth refresh: rejected refresh token hint", () => {
  let dir: string
  const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
  let refreshError: Error

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-refresh-hint-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    refreshError = new Error(
      'Hint OAuth refresh failed (400): {"error": "invalid_grant", "error_description": "Refresh token expired"}',
    )

    const oauthLogin: OAuthLoginProvider = {
      serviceId: SERVICE,
      displayName: "Hint OAuth Default",
      config: () => ({
        clientId: "t",
        tokenUrl: "https://example.test/token",
        authorizeUrl: "https://example.test/authorize",
        redirectUri: "https://example.test/cb",
        scopes: ["t"],
      }),
      buildCredential: () => {
        throw new Error("not used")
      },
      readAuth(secrets) {
        const t = secrets.accessToken
        return typeof t === "string" && t ? { kind: "oauth", token: t } : null
      },
      async refreshCredential() {
        throw refreshError
      },
    }
    registerTestProvider({
      id: "hint-prov",
      displayName: "Hint Prov",
      shortCode: "hp",
      models: [{ id: "hint-model" }],
      oauthLogin,
    })
    defaultAuthStore().set(SERVICE, "hint-oauth-5", {
      tokenType: "oauth",
      accessToken: "expired",
      refreshToken: "dead-rt",
      expiresAt: 1,
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
    else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
  })

  function resolveRefresh(): () => Promise<{ token: string }> {
    const auth = tryResolveProviderAuth("hint-prov", "", "hint-oauth-5")
    if (!auth || auth.kind !== "oauth" || !auth.refresh) throw new Error("no refresh closure")
    return auth.refresh
  }

  it("FAIL-FIRST: invalid_grant names the login command for this credential slot", async () => {
    const err = (await resolveRefresh()().then(
      () => new Error("refresh unexpectedly resolved"),
      (e: unknown) => e,
    )) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("invalid_grant")
    expect(err.message).toContain("minimal-agent provider hint-prov login --name hint-oauth-5")
    expect(err.cause).toBe(refreshError)
  })

  it("passes other refresh errors through unchanged", async () => {
    refreshError = new Error("Hint OAuth refresh failed (503): upstream")
    const err = await resolveRefresh()().catch((e: unknown) => e)
    expect(err).toBe(refreshError)
  })
})

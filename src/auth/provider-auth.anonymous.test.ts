/**
 * resolveStartupAuth uses ProviderPlugin.anonymousAuth when no credential is
 * stored, and the startup banner labels it `anonymous (<providerId>)`.
 *
 * @module auth/provider-auth.anonymous.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import {
  type ApiKeyAuthProvider,
  clearProviderPlugins,
  registerProviderPlugin,
} from "../llm/provider-plugin.ts"

import { defaultAuthStore, resetDefaultAuthStoreForTests } from "./auth-store.ts"
import { NoProviderCredentialsError } from "./errors.ts"
import { resolveStartupAuth, startupAuthLabel } from "./provider-auth.ts"

const API_KEY_AUTH: ApiKeyAuthProvider = {
  serviceId: "anon-test-api-key",
  displayName: "Anon Test API Key",
  buildCredential: (apiKey: string) => ({
    serviceId: "anon-test-api-key",
    displayName: "Anon Test API Key",
    secrets: { tokenType: "api-key", apiKey },
  }),
  readApiKey: (secrets: Record<string, unknown>) =>
    typeof secrets.apiKey === "string" ? secrets.apiKey : null,
}

function registerAnon(withAnonymous = true): void {
  registerProviderPlugin({
    id: "anon-zen",
    displayName: "Anon Zen",
    shortCode: "az",
    register() {},
    apiKeyAuth: API_KEY_AUTH,
    ...(withAnonymous
      ? { anonymousAuth: () => ({ kind: "api-key" as const, key: "public" }) }
      : {}),
  })
}

describe("resolveStartupAuth anonymous fallback", () => {
  let dir: string
  const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
  const prevTestAuth = process.env.MINIMAL_AGENT_TEST_AUTH

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-anon-auth-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    delete process.env.MINIMAL_AGENT_TEST_AUTH
    resetDefaultAuthStoreForTests()
    clearProviderPlugins()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    resetDefaultAuthStoreForTests()
    clearProviderPlugins()
    if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
    else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
    if (prevTestAuth === undefined) delete process.env.MINIMAL_AGENT_TEST_AUTH
    else process.env.MINIMAL_AGENT_TEST_AUTH = prevTestAuth
  })

  it("returns the anonymous auth and labels it in the banner", async () => {
    registerAnon()
    const auth = await resolveStartupAuth("anon-zen", "free-model")
    expect(auth).toEqual({ type: "api-key", token: "public" })
    expect(stripAnsi(startupAuthLabel(auth, "anon-zen"))).toBe("anonymous (anon-zen)")
  })

  it("prefers a stored credential and keeps the normal label", async () => {
    registerAnon()
    defaultAuthStore().set("anon-test-api-key", "Anon Test API Key", {
      tokenType: "api-key",
      apiKey: "sk-real",
    })
    const auth = await resolveStartupAuth("anon-zen", "free-model")
    expect(auth).toEqual({ type: "api-key", token: "sk-real" })
    expect(stripAnsi(startupAuthLabel(auth, "anon-zen"))).toBe("api-key (anon-zen)")
  })

  it("still throws for a missing explicit credential name", async () => {
    registerAnon()
    const err = await resolveStartupAuth("anon-zen", "free-model", "Missing").catch((e) => e)
    expect(err).toBeInstanceOf(NoProviderCredentialsError)
    expect(err.kind).toBe("NoProviderCredentialsError")
    expect(err.providerId).toBe("anon-zen")
    expect(err.modelId).toBe("free-model")
  })

  it("still throws when the provider has no anonymousAuth", async () => {
    registerAnon(false)
    const err = await resolveStartupAuth("anon-zen", "free-model").catch((e) => e)
    expect(err).toBeInstanceOf(NoProviderCredentialsError)
    expect(err.providerId).toBe("anon-zen")
  })
})

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
import { runInSessionScope, type SessionScope } from "../../infra/session-scope.ts"
import { clearModelRegistry, clearProviderRegistry } from "../../llm/model-registry.ts"
import type { ProviderAuth } from "../../llm/provider.ts"
import { clearProviderPlugins } from "../../llm/provider-plugin.ts"
import { registerTestProvider } from "../../llm/test-fixtures.ts"
import type { SendOptions, StreamedResponse } from "../../llm/transport/types.ts"
import type { TargetSnapshot } from "../types.ts"

import { type BuildHostOptions, buildPluginHost } from "./factory.ts"
import type { LlmSideDeps } from "./providers/llm-side.ts"

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

  it("returns clean text after a retry that followed streamed text (no stall marker)", async () => {
    const handle = registerTestProvider({
      id: "llm-retry-prov",
      models: [{ id: "llm-retry-model" }],
      apiKeyAuth: {
        serviceId: "llm-retry-api",
        displayName: "LLM Retry Key",
        buildCredential: (apiKey: string) => ({
          serviceId: "llm-retry-api",
          displayName: "LLM Retry Key",
          secrets: { tokenType: "api-key", apiKey },
        }),
        readApiKey: (secrets: Record<string, unknown>) =>
          typeof secrets.apiKey === "string" ? secrets.apiKey : null,
      },
    })
    let calls = 0
    handle.adapter.run = async function* () {
      calls++
      if (calls === 1) {
        yield { type: "text_delta", index: 0, text: "partial" }
        throw Object.assign(new Error("stream_idle"), { streamErrorType: "stream_idle" })
      }
      yield { type: "text_delta", index: 0, text: "done" }
      yield { type: "message_stop" }
    }
    defaultAuthStore().set("llm-retry-api", "LLM Retry Key", {
      tokenType: "api-key",
      apiKey: "sk-llm-retry",
    })
    const origRandom = Math.random
    Math.random = () => 0 // backoff to 0ms
    try {
      const host = buildPluginHost({ capabilities: ["llm:complete"] })
      const text = await host.llm?.complete({
        model: "llm-retry-model",
        system: "s",
        userText: "u",
      })
      expect(calls).toBe(2)
      expect(text).toBe("partialdone")
      expect(text).not.toContain("stream stalled")
      expect(text).not.toContain("stalled")
    } finally {
      Math.random = origRandom
    }
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

describe("plugin host: llm.request uses the credential of the session target", () => {
  const PROV = "host-cred-prov"
  const MODEL = "host-cred-model"
  const REQ = { purpose: "title" as const, model: MODEL, system: "s", userText: "u" }
  let authCalls: unknown[][]

  /** Fake transport and spy auth resolver. The credential name is NOT injected. */
  const llmSide: LlmSideDeps = {
    // biome-ignore lint/correctness/useYield: the fake yields no text delta.
    attemptFn: async function* (_opts: SendOptions): AsyncGenerator<string, StreamedResponse> {
      return { blocks: [], text: "ok", stopReason: "end_turn" }
    },
    resolveAuth: async (...args: unknown[]) => {
      authCalls.push(args)
      return { type: "api-key", token: "test-token" }
    },
    sessionProviderId: () => PROV,
  }

  const scopeWith = (target: TargetSnapshot): SessionScope =>
    ({ sid: "host-cred-sid", queryTarget: () => target }) as unknown as SessionScope

  beforeEach(() => {
    authCalls = []
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    registerTestProvider({
      id: PROV,
      models: [{ id: MODEL, pricing: { inputUSD: 0.5, outputUSD: 2 } }],
    })
  })

  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  it("with no scope, the host target credential reaches the auth resolver", async () => {
    const host = buildPluginHost({
      capabilities: ["llm:complete"],
      llmSide,
      target: () => ({ providerId: PROV, credentialName: "cred-pinned" }),
    } as BuildHostOptions)
    const r = await host.llm?.request?.(REQ)
    expect(r?.stopReason).toBe("end_turn")
    expect(authCalls).toHaveLength(1)
    expect(authCalls[0]?.[2]).toBe("cred-pinned")
  })

  it("a host target of another provider gives no credential name", async () => {
    const host = buildPluginHost({
      capabilities: ["llm:complete"],
      llmSide,
      target: () => ({ providerId: "host-cred-other", credentialName: "cred-pinned" }),
    } as BuildHostOptions)
    await host.llm?.request?.(REQ)
    expect(authCalls[0]?.[2]).toBeUndefined()
  })

  it("a scope target wins over the host target", async () => {
    const host = buildPluginHost({
      capabilities: ["llm:complete"],
      llmSide,
      target: () => ({ providerId: PROV, credentialName: "cred-default" }),
    } as BuildHostOptions)
    const scope = scopeWith({ providerId: PROV, model: MODEL, credentialName: "cred-pinned" })
    await runInSessionScope(scope, () => host.llm?.request?.(REQ))
    expect(authCalls[0]?.[2]).toBe("cred-pinned")
  })

  it("a scope with no credential name does not use the host target", async () => {
    const host = buildPluginHost({
      capabilities: ["llm:complete"],
      llmSide,
      target: () => ({ providerId: PROV, credentialName: "cred-pinned" }),
    } as BuildHostOptions)
    const scope = scopeWith({ providerId: PROV, model: MODEL })
    await runInSessionScope(scope, () => host.llm?.request?.(REQ))
    expect(authCalls).toHaveLength(1)
    expect(authCalls[0]?.[2]).toBeUndefined()
  })

  it("a throwing host target gives no credential name, and the call still runs", async () => {
    const host = buildPluginHost({
      capabilities: ["llm:complete"],
      llmSide,
      target: () => {
        throw new Error("no live core")
      },
    } as BuildHostOptions)
    const r = await host.llm?.request?.(REQ)
    expect(r?.stopReason).toBe("end_turn")
    expect(authCalls[0]?.[2]).toBeUndefined()
  })
})

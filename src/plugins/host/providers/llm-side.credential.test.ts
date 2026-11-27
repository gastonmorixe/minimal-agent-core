/**
 * `llm.request()` uses the credential of the session, not the default
 * stored credential of the provider.
 *
 * A session can pin a named credential (`--credential-name`, a target
 * switch). A side call (the title plugin) must send with that credential.
 * The default resolver reads the name from the current session scope
 * target, and only when the target provider is the provider of the model.
 *
 * All sends go to a fake transport and a spy auth resolver. No network, no
 * auth store.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { runInSessionScope, type SessionScope } from "../../../infra/session-scope.ts"
import { clearModelRegistry, clearProviderRegistry } from "../../../llm/model-registry.ts"
import { clearProviderPlugins } from "../../../llm/provider-plugin.ts"
import { registerTestProvider } from "../../../llm/test-fixtures.ts"
import type { SendOptions, StreamedResponse } from "../../../llm/transport/types.ts"
import type { TargetSnapshot } from "../../types.ts"

import { createLlmSideRequest, type LlmSideDeps } from "./llm-side.ts"

const PROV = "cred-side-prov"
const OTHER = "cred-side-other"
const CHEAP = "cred-side-cheap-1"
const BASE = { purpose: "title" as const, system: "sys", userText: "hello", timeoutMs: 5_000 }

/** Each call of the spy resolver: the full argument list. */
type AuthCall = unknown[]

function spyDeps(calls: AuthCall[], extra: Partial<LlmSideDeps> = {}): LlmSideDeps {
  return {
    // biome-ignore lint/correctness/useYield: the fake yields no text delta.
    attemptFn: async function* (_opts: SendOptions): AsyncGenerator<string, StreamedResponse> {
      return { blocks: [], text: "ok", stopReason: "end_turn" }
    },
    resolveAuth: async (...args: unknown[]) => {
      calls.push(args)
      return { type: "oauth", token: "test-token-pinned", accountUuid: "test-account" }
    },
    sessionProviderId: () => PROV,
    ...extra,
  }
}

function scopeWith(target: () => TargetSnapshot): SessionScope {
  return { sid: "cred-side-sid", queryTarget: target } as unknown as SessionScope
}

beforeEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
  registerTestProvider({
    id: PROV,
    models: [{ id: CHEAP, pricing: { inputUSD: 0.5, outputUSD: 2 } }],
  })
})

afterEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

describe("llm.request: credential of the session (scope target)", () => {
  it("passes the scope credential name to resolveAuth", async () => {
    const calls: AuthCall[] = []
    const request = createLlmSideRequest(spyDeps(calls))
    const scope = scopeWith(() => ({
      providerId: PROV,
      model: CHEAP,
      credentialName: "cred-pinned",
    }))
    const r = await runInSessionScope(scope, () => request({ ...BASE, model: CHEAP }))
    expect(r.stopReason).toBe("end_turn")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe(PROV)
    expect(calls[0]?.[1]).toBe(CHEAP)
    expect(calls[0]?.[2]).toBe("cred-pinned")
  })

  it("a scope target of another provider gives no credential name", async () => {
    const calls: AuthCall[] = []
    const request = createLlmSideRequest(spyDeps(calls))
    const scope = scopeWith(() => ({
      providerId: OTHER,
      model: "other-model",
      credentialName: "cred-pinned",
    }))
    await runInSessionScope(scope, () => request({ ...BASE, model: CHEAP }))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[2]).toBeUndefined()
  })

  it("no scope gives no credential name (the provider default)", async () => {
    const calls: AuthCall[] = []
    const request = createLlmSideRequest(spyDeps(calls))
    await request({ ...BASE, model: CHEAP })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[2]).toBeUndefined()
  })

  it("a throwing queryTarget gives no credential name, and the call still runs", async () => {
    const calls: AuthCall[] = []
    const request = createLlmSideRequest(spyDeps(calls))
    const scope = scopeWith(() => {
      throw new Error("no live target")
    })
    const r = await runInSessionScope(scope, () => request({ ...BASE, model: CHEAP }))
    expect(r.stopReason).toBe("end_turn")
    expect(r.text).toBe("ok")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[2]).toBeUndefined()
  })

  it("an injected sessionCredentialName wins, and gets the model provider", async () => {
    const calls: AuthCall[] = []
    const seen: string[] = []
    const request = createLlmSideRequest(
      spyDeps(calls, {
        sessionCredentialName: (providerId: string) => {
          seen.push(providerId)
          return "cred-injected"
        },
      }),
    )
    await request({ ...BASE, model: CHEAP })
    expect(seen).toEqual([PROV])
    expect(calls[0]?.[2]).toBe("cred-injected")
  })

  it("a throwing sessionCredentialName gives no name, and the call still runs", async () => {
    const calls: AuthCall[] = []
    const request = createLlmSideRequest(
      spyDeps(calls, {
        sessionCredentialName: () => {
          throw new Error("broken getter")
        },
      }),
    )
    const r = await request({ ...BASE, model: CHEAP })
    expect(r.stopReason).toBe("end_turn")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[2]).toBeUndefined()
  })
})

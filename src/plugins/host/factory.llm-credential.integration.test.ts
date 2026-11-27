/**
 * Side calls use the credential of the session: the REAL auth path.
 *
 * A temp auth file holds 2 stored credentials of one provider. The store
 * default is the auto name with the lowest number (`<slug>-1`). The session
 * pins the other one (`<slug>-2`). `llm.request()` and `llm.complete()` must
 * send with the pinned token, not with the store default.
 *
 * No auth resolver is injected and `MINIMAL_AGENT_TEST_AUTH` is not set, so
 * `resolveStartupAuth` reads the auth store. `llm.request()` gets only a
 * recording `attemptFn`. `llm.complete()` runs the real canonical transport
 * into a fake adapter that records `ctx.auth` (no network).
 *
 * All values are fake: test provider ids, auto names, `test-token-*` keys.
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
import type { RunModeFact } from "../types.ts"

import { type BuildHostOptions, buildPluginHost } from "./factory.ts"

const PROV = "cred-int-prov"
const MODEL = "cred-int-model"
const SLUG = "cred-int-api"
const DISPLAY = "Cred Int Key"
/** The store default: the auto name with the lowest number. */
const NAME_DEFAULT = `${SLUG}-1`
/** The credential that the session pins. */
const NAME_PINNED = `${SLUG}-2`
const TOKEN_DEFAULT = "test-token-default"
const TOKEN_PINNED = "test-token-pinned"

const REQ = { purpose: "title" as const, model: MODEL, system: "s", userText: "u" }
const RUN: RunModeFact = { mode: "repl", interactive: true, providerId: PROV }

describe("side calls: the session credential on the real auth path", () => {
  let dir: string
  const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
  const prevTestAuth = process.env.MINIMAL_AGENT_TEST_AUTH
  /** The auth of each `llm.request()` attempt. */
  let attemptAuth: SendOptions["auth"][]
  /** The auth of each adapter run (`llm.complete()`). */
  let adapterAuth: ProviderAuth[]

  // biome-ignore lint/correctness/useYield: the fake yields no text delta.
  const attemptFn = async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse> {
    attemptAuth.push(opts.auth)
    return { blocks: [], text: "ok", stopReason: "end_turn" }
  }

  const pinnedTarget = () => ({ providerId: PROV, model: MODEL, credentialName: NAME_PINNED })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-llm-cred-int-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    delete process.env.MINIMAL_AGENT_TEST_AUTH
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    attemptAuth = []
    adapterAuth = []
    const handle = registerTestProvider({
      id: PROV,
      models: [{ id: MODEL, pricing: { inputUSD: 0.5, outputUSD: 2 } }],
      apiKeyAuth: {
        serviceId: SLUG,
        displayName: DISPLAY,
        buildCredential: (apiKey: string) => ({
          serviceId: SLUG,
          displayName: DISPLAY,
          secrets: { tokenType: "api-key", apiKey },
        }),
        readApiKey: (secrets: Record<string, unknown>) =>
          typeof secrets.apiKey === "string" ? secrets.apiKey : null,
      },
    })
    handle.adapter.run = async function* (_req, _model, ctx) {
      adapterAuth.push(ctx.auth)
      yield { type: "text_delta", index: 0, text: "summary-ok" }
      yield { type: "message_stop" }
    }
    const store = defaultAuthStore()
    store.set(SLUG, NAME_DEFAULT, { tokenType: "api-key", apiKey: TOKEN_DEFAULT })
    store.set(SLUG, NAME_PINNED, { tokenType: "api-key", apiKey: TOKEN_PINNED })
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

  it("the store default is the lowest auto name (control)", () => {
    expect(defaultAuthStore().defaultName(SLUG, DISPLAY)).toBe(NAME_DEFAULT)
  })

  it("llm.request with no session target sends the store default (no change)", async () => {
    const host = buildPluginHost({
      capabilities: ["llm:complete"],
      runMode: () => RUN,
      llmSide: { attemptFn },
    })
    const r = await host.llm?.request?.(REQ)
    expect(r?.stopReason).toBe("end_turn")
    expect(attemptAuth).toEqual([{ type: "api-key", token: TOKEN_DEFAULT }])
  })

  it("llm.request sends the token of the host target credential", async () => {
    const host = buildPluginHost({
      capabilities: ["llm:complete"],
      runMode: () => RUN,
      llmSide: { attemptFn },
      target: pinnedTarget,
    } as BuildHostOptions)
    const r = await host.llm?.request?.(REQ)
    expect(r?.stopReason).toBe("end_turn")
    expect(attemptAuth).toEqual([{ type: "api-key", token: TOKEN_PINNED }])
  })

  it("llm.request in a session scope sends the token of the scope credential", async () => {
    const host = buildPluginHost({ capabilities: ["llm:complete"], llmSide: { attemptFn } })
    const scope = { sid: "cred-int-sid", queryTarget: pinnedTarget } as unknown as SessionScope
    const r = await runInSessionScope(scope, () => host.llm?.request?.(REQ))
    expect(r?.stopReason).toBe("end_turn")
    expect(attemptAuth).toEqual([{ type: "api-key", token: TOKEN_PINNED }])
  })

  it("llm.request on the real transport (no attemptFn) sends the pinned token", async () => {
    // The transport reads the store again with `SendOptions.credentialName`,
    // so the name must ride the request, not only the first auth step.
    const host = buildPluginHost({
      capabilities: ["llm:complete"],
      runMode: () => RUN,
      target: pinnedTarget,
    } as BuildHostOptions)
    const r = await host.llm?.request?.(REQ)
    expect(r?.text).toBe("summary-ok")
    expect(adapterAuth).toEqual([{ kind: "api-key", key: TOKEN_PINNED }])
  })

  it("llm.complete with no session target sends the store default (no change)", async () => {
    const host = buildPluginHost({ capabilities: ["llm:complete"] })
    const text = await host.llm?.complete({ model: MODEL, system: "s", userText: "u" })
    expect(text).toBe("summary-ok")
    expect(adapterAuth).toEqual([{ kind: "api-key", key: TOKEN_DEFAULT }])
  })

  it("llm.complete sends the token of the host target credential", async () => {
    const host = buildPluginHost({
      capabilities: ["llm:complete"],
      target: pinnedTarget,
    } as BuildHostOptions)
    const text = await host.llm?.complete({ model: MODEL, system: "s", userText: "u" })
    expect(text).toBe("summary-ok")
    expect(adapterAuth).toEqual([{ kind: "api-key", key: TOKEN_PINNED }])
  })

  it("llm.complete in a session scope sends the token of the scope credential", async () => {
    const host = buildPluginHost({ capabilities: ["llm:complete"] })
    const scope = { sid: "cred-int-sid", queryTarget: pinnedTarget } as unknown as SessionScope
    const text = await runInSessionScope(scope, () =>
      host.llm?.complete({ model: MODEL, system: "s", userText: "u" }),
    )
    expect(text).toBe("summary-ok")
    expect(adapterAuth).toEqual([{ kind: "api-key", key: TOKEN_PINNED }])
  })
})

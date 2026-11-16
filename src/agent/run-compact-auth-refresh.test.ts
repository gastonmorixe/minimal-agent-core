/**
 * Regression: /compact local summary must recover from an expired OAuth
 * access token the same way live turns do (401, then refresh, then retry).
 *
 * Field symptom (session 988d73d0, 2026-10-15): a resumed session ran
 * /compact while the stored access token for its credential had expired.
 * The summary call went straight to `run()` with no auth-refresh layer, got
 * 401 "OAuth access token has expired", and fell back to the stub summary.
 * A peer session refreshed the same credential 24s later and worked.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { defaultAuthStore, resetDefaultAuthStoreForTests } from "../auth/auth-store.ts"
import type { CanonicalEvent } from "../llm/canonical-events.ts"
import type { Message } from "../llm/messages.ts"
import { clearModelRegistry, clearProviderRegistry } from "../llm/model-registry.ts"
import { clearProviderPlugins, type OAuthLoginProvider } from "../llm/provider-plugin.ts"
import {
  registerTestProvider,
  sseBodyFromEvents,
  type TestProviderHandle,
} from "../llm/test-fixtures.ts"
import { NetworkClient, NetworkResponse, type NetworkTransport } from "../network/index.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { COMPACT_TEST_TEXT } from "../test-utils/compact-test-text.ts"

import { runCompact } from "./run-compact.ts"

const SERVICE = "compact-oauth-svc"
const CRED = "compact-oauth-cred-12"

function summaryEvents(text: string): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "msg_compact_oauth",
      modelId: "compact-oauth-model",
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text },
    { type: "text_stop", index: 0 },
    { type: "message_delta", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
    { type: "message_stop" },
  ]
}

describe("runCompact local summary OAuth refresh", () => {
  let dir: string
  const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
  let refreshCalls = 0
  let remoteTokens: string[] = []
  let refreshedToken = "fresh-token"
  let onFirstRemoteCall: (() => void) | undefined
  let handle: TestProviderHandle

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-run-compact-oauth-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    refreshCalls = 0
    refreshedToken = "fresh-token"
    onFirstRemoteCall = undefined

    const oauthLogin: OAuthLoginProvider = {
      serviceId: SERVICE,
      displayName: "Compact OAuth Default",
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
      async refreshCredential(secrets) {
        refreshCalls++
        return {
          credential: {
            serviceId: SERVICE,
            displayName: CRED,
            secrets: { ...secrets, accessToken: refreshedToken, refreshToken: "rt-2" },
          },
          result: { accessToken: refreshedToken, refreshToken: "rt-2", expiresAt: 0, scopes: [] },
        }
      },
    }

    handle = registerTestProvider({
      id: "compact-oauth-prov",
      displayName: "Compact OAuth Prov",
      shortCode: "cop",
      models: [{ id: "compact-oauth-model" }],
      oauthLogin,
    })
    remoteTokens = []
    handle.adapter.compact = async (_input, _model, ctx) => {
      const token = ctx.auth.kind === "oauth" ? ctx.auth.token : ""
      remoteTokens.push(token)
      if (remoteTokens.length === 1) onFirstRemoteCall?.()
      if (token !== "fresh-token") {
        throw Object.assign(new Error("HTTP 401: OAuth access token has expired"), { status: 401 })
      }
      return {
        kind: "remote",
        replacementMessages: [
          { role: "user", content: "remote-compacted" },
          { role: "assistant", content: "ok" },
        ],
      }
    }

    defaultAuthStore().set(SERVICE, CRED, {
      tokenType: "oauth",
      accessToken: "expired-token",
      refreshToken: "rt-1",
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

  it("FAIL-FIRST: refreshes an expired stored token on 401 and lands the summary", async () => {
    const seenAuth: string[] = []
    const transport: NetworkTransport = {
      id: "fake",
      request: async (req) => {
        const auth = (req.headers as Record<string, string>)?.authorization ?? ""
        seenAuth.push(auth)
        if (auth !== "Bearer fresh-token") {
          return new NetworkResponse({
            status: 401,
            headers: { "content-type": "application/json" },
            transport: { id: "fake", protocol: "h2" },
            body: new Response(
              '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."}}',
            ).body!,
          })
        }
        return new NetworkResponse({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          transport: { id: "fake", protocol: "h2" },
          body: sseBodyFromEvents(summaryEvents("real-summary-text")),
        })
      },
    }
    const messages: Message[] = []
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "user", content: `u${i}` })
      messages.push({ role: "assistant", content: `a${i}` })
    }
    const stats = await runCompact({
      text: COMPACT_TEST_TEXT,
      lifecycle: NOOP_LIFECYCLE,
      messages,
      model: "compact-oauth-model",
      providerId: "compact-oauth-prov",
      credentialName: CRED,
      auth: { type: "oauth", token: "expired-token" },
      reason: "manual",
      mode: "local",
      networkClient: new NetworkClient({ primary: transport }),
      sleep: async () => {},
    })
    expect(stats.summaryError).toBeUndefined()
    expect(stats.summaryText ?? "").toContain("real-summary-text")
    expect(refreshCalls).toBe(1)
    expect(seenAuth.at(-1)).toBe("Bearer fresh-token")
  })

  it("FAIL-FIRST: a stream_error whose cause names 401 refreshes once and lands the summary", async () => {
    // run() yields a non-retryable stream_error whose cause is an Error that
    // names HTTP 401 (no pre-stream HTTP status). The typed
    // CompactSummaryStreamError must carry status 401 so the OAuth recovery
    // runs once and the retry lands the real summary (not the stub).
    const seenTokens: string[] = []
    handle.adapter.run = async function* (_req, _model, ctx) {
      const token = ctx.auth.kind === "oauth" ? ctx.auth.token : ""
      seenTokens.push(token)
      if (token !== "fresh-token") {
        yield {
          type: "stream_error",
          retryable: false,
          cause: new Error("HTTP 401: OAuth access token has expired"),
        }
        return
      }
      yield* summaryEvents("stream-401-summary-text")
    }
    const messages: Message[] = []
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "user", content: `u${i}` })
      messages.push({ role: "assistant", content: `a${i}` })
    }
    const stats = await runCompact({
      text: COMPACT_TEST_TEXT,
      lifecycle: NOOP_LIFECYCLE,
      messages,
      model: "compact-oauth-model",
      providerId: "compact-oauth-prov",
      credentialName: CRED,
      auth: { type: "oauth", token: "expired-token" },
      reason: "manual",
      mode: "local",
      sleep: async () => {},
    })
    expect(stats.summaryError).toBeUndefined()
    expect(stats.summaryText ?? "").toContain("stream-401-summary-text")
    expect(refreshCalls).toBe(1)
    expect(seenTokens).toEqual(["expired-token", "fresh-token"])
  })

  it("FAIL-FIRST: remote compact refreshes an expired stored token on 401", async () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]
    const notes: string[] = []
    const stats = await runCompact({
      text: COMPACT_TEST_TEXT,
      lifecycle: NOOP_LIFECYCLE,
      messages,
      model: "compact-oauth-model",
      providerId: "compact-oauth-prov",
      credentialName: CRED,
      auth: { type: "oauth", token: "expired-token" },
      reason: "manual",
      mode: "remote",
      appendNote: (t) => notes.push(t),
    })
    expect(stats.kind).toBe("remote")
    expect(refreshCalls).toBe(1)
    expect(remoteTokens).toEqual(["expired-token", "fresh-token"])
  })

  it("adopts a peer-rotated stored token without a network refresh", async () => {
    // A peer process rotates the stored token while our first request is in
    // flight. The 401 recovery must pick it up from the store, not refresh.
    onFirstRemoteCall = () =>
      defaultAuthStore().set(SERVICE, CRED, {
        tokenType: "oauth",
        accessToken: "fresh-token",
        refreshToken: "rt-peer",
        expiresAt: Date.now() + 3_600_000,
      })
    const stats = await runCompact({
      text: COMPACT_TEST_TEXT,
      lifecycle: NOOP_LIFECYCLE,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      model: "compact-oauth-model",
      providerId: "compact-oauth-prov",
      credentialName: CRED,
      auth: { type: "oauth", token: "expired-token" },
      reason: "manual",
      mode: "remote",
    })
    expect(stats.kind).toBe("remote")
    expect(refreshCalls).toBe(0)
    expect(remoteTokens).toEqual(["expired-token", "fresh-token"])
  })

  it("stops after one refresh when the 401 persists (no loop)", async () => {
    refreshedToken = "still-rejected-token"
    const notes: string[] = []
    const stats = await runCompact({
      text: COMPACT_TEST_TEXT,
      lifecycle: NOOP_LIFECYCLE,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      model: "compact-oauth-model",
      providerId: "compact-oauth-prov",
      credentialName: CRED,
      auth: { type: "oauth", token: "expired-token" },
      reason: "manual",
      mode: "remote",
      appendNote: (t) => notes.push(t),
    })
    expect(stats.kind).not.toBe("remote")
    expect(refreshCalls).toBe(1)
    expect(remoteTokens).toEqual(["expired-token", "still-rejected-token"])
  })
})

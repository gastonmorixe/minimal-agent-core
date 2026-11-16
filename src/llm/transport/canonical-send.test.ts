/**
 * End-to-end tests for the canonical transport (`canonicalSendFn`).
 *
 * These prove the Phase-1 claim: a transport that routes through the
 * canonical `run()` is observably interchangeable with the legacy
 * `sendMessage` behind `Agent.sendFn`, AND it dispatches each model to the
 * provider that OWNS it (the whole point of the migration).
 *
 * Post A-3 (PLAN.md Wave A): the suite drives the stack through the
 * synthetic in-test provider fixture (`src/llm/test-fixtures.ts`) instead
 * of bootstrapping real adapters from `plugins/` (invariant I2: core never
 * imports plugins). Provider ids ("anthropic", "openai") still appear AS
 * DATA because `canonicalSendFn`'s credential strategy is keyed by
 * provider id until C-5 makes it a plugin hook; the real adapters' own
 * wire behavior (SSE translation, real URLs, captured fixtures) is pinned
 * in each plugin's suite. The fake adapter speaks canonical-event SSE, so
 * every scenario here is expressed in canonical terms.
 *
 * Full retry / watchdog / 401 middleware is Phase 2; this is the raw path.
 *
 * @module llm/transport/canonical-send.test
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import {
  defaultAuthStore,
  resetDefaultAuthStoreForTests,
  type SecretBag,
} from "../../auth/auth-store.ts"
import { getDiagnosticBus } from "../../bus/diagnostic-bus.ts"
import { setGlobalEventBus } from "../../bus/global-bus.ts"
import type { StatusActivity } from "../../bus/status.ts"
import type { StatusFields, StatusPort } from "../../bus/status-port.ts"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "../../network/index.ts"
import { EventBus } from "../../plugins/event-bus.ts"
import { QUOTA_HEADERS_RECEIVED } from "../../quota/quota-broadcast.ts"
import { clearSessionTokens, getSessionTokens } from "../../session/session-tokens.ts"
import type { CanonicalEvent } from "../canonical-events.ts"
import type { Message } from "../messages.ts"
import type { ApiKeyAuthProvider, OAuthLoginProvider } from "../provider-plugin.ts"
import { registerTestProvider, sseBodyFromEvents, testProviderUrl } from "../test-fixtures.ts"

import { canonicalSendFn } from "./canonical-send.ts"
import type { StreamedResponse } from "./types.ts"
import { DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "./watchdog.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeHandler = (req: NetworkRequest) => NetworkResponse | Promise<NetworkResponse>

function fakeNetworkClient(handler: FakeHandler): NetworkClient {
  const transport: NetworkTransport = { id: "fake", request: async (req) => handler(req) }
  return new NetworkClient({ primary: transport })
}

/** SSE response whose `data:` lines are canonical events (the fixture wire). */
function sseFromEvents(events: CanonicalEvent[]): NetworkResponse {
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_cs_001" },
    transport: { id: "fake", protocol: "h2" },
    body: sseBodyFromEvents(events),
  })
}

/** A complete single-text-block stream: `text` then a clean `end_turn`. */
function pongEvents(text = "pong"): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "msg_pong",
      modelId: "key-model",
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text },
    { type: "text_stop", index: 0 },
    {
      type: "message_delta",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    { type: "message_stop" },
  ]
}

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

const openAITestApiKeyAuth: ApiKeyAuthProvider = {
  serviceId: "key-prov-api-key",
  displayName: "Key Provider API Key",
  buildCredential(apiKey) {
    return {
      serviceId: this.serviceId,
      displayName: this.displayName,
      secrets: { api_key: apiKey },
    }
  },
  readApiKey(secrets) {
    const value = secrets.api_key
    return typeof value === "string" ? value : null
  },
}

// A minimal OAuth strategy for the "anthropic" test provider. The transport
// resolves EVERY provider's credential from the store (no provider gets a
// special-cased branch), so the anthropic-model tests register + store an OAuth
// credential here exactly like a real provider plugin would.
const anthropicTestOAuth: OAuthLoginProvider = {
  serviceId: "oauth-prov-plan",
  displayName: "OAuth Provider Plan",
  config: () => ({
    clientId: "test",
    tokenUrl: "https://example.test/token",
    authorizeUrl: "https://example.test/authorize",
    redirectUri: "https://example.test/callback",
    scopes: ["test"],
  }),
  buildCredential(raw) {
    const token = typeof raw.access_token === "string" ? raw.access_token : ""
    return {
      credential: {
        serviceId: this.serviceId,
        displayName: this.displayName,
        secrets: { tokenType: "oauth", accessToken: token, refreshToken: `${token}-refresh` },
      },
      result: {
        accessToken: token,
        // Defense in depth: a seeded test credential carries a refresh token
        // so that, even if it ever leaks into a real store, the refresh path
        // cannot fail with "no refresh token".
        refreshToken: `${token}-refresh`,
        expiresAt: 0,
        scopes: [],
      },
    }
  },
  readAuth(secrets) {
    const token = secrets.accessToken
    return typeof token === "string" && token ? { kind: "oauth", token } : null
  },
}

function writeStoredAnthropicToken(token: string): void {
  const write = anthropicTestOAuth.buildCredential({ access_token: token })
  defaultAuthStore().set(
    write.credential.serviceId,
    write.credential.displayName,
    write.credential.secrets as SecretBag,
  )
}

// Module-scope auth-store sandbox. The seeding below writes to
// `defaultAuthStore()`, which resolves to the REAL `~/.minimal-agent/auth.jsonc`
// unless `MINIMAL_AGENT_AUTH_FILE` is redirected. This hook runs at module load,
// BEFORE the per-suite `beforeEach` sandboxes further down, so without this the
// `writeStoredAnthropicToken` seed would overwrite the user's live Anthropic
// credential with a synthetic token-only bag (no refresh token), breaking the
// real refresh path. Redirect to a temp file FIRST, then seed.
const prevModuleAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
let moduleAuthDir: string

// Synthetic registrations replace the real adapter bootstraps. The fake
// providers REUSE the real provider ids as test data; each id's model set
// and auth strategy mirrors what the tests dispatch without importing
// provider plugins into core.
beforeAll(() => {
  // Sandbox the store BEFORE any write so the real credential is never touched.
  moduleAuthDir = mkdtempSync(join(tmpdir(), "minimal-agent-cs-auth-"))
  process.env.MINIMAL_AGENT_AUTH_FILE = join(moduleAuthDir, "auth.jsonc")
  resetDefaultAuthStoreForTests()

  registerTestProvider({
    id: "oauth-prov",
    models: [{ id: "oauth-model", aliases: ["oauth-model[1m]"] }],
    oauthLogin: anthropicTestOAuth,
  })
  // The transport resolves the anthropic credential from the store (no
  // special-cased branch), so seed it for the module-level store tests.
  writeStoredAnthropicToken("test-token")
  registerTestProvider({
    id: "key-prov",
    models: [{ id: "key-model" }, { id: "key-model-2" }],
    apiKeyAuth: openAITestApiKeyAuth,
  })
})

afterAll(() => {
  if (prevModuleAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
  else process.env.MINIMAL_AGENT_AUTH_FILE = prevModuleAuthFile
  resetDefaultAuthStoreForTests()
  if (moduleAuthDir) rmSync(moduleAuthDir, { recursive: true, force: true })
  // Every completed send adds to the process-wide session-token totals; leave
  // them at zero for the next file in a shared `bun test` process.
  clearSessionTokens()
})

function writeStoredOpenAIKey(apiKey: string): void {
  const write = openAITestApiKeyAuth.buildCredential(apiKey)
  defaultAuthStore().set(write.serviceId, write.displayName, write.secrets as SecretBag)
}

// ---------------------------------------------------------------------------
// Equivalence with the Phase-0 legacy golden (yields / callbacks / response)
// ---------------------------------------------------------------------------

describe("canonicalSendFn — equivalence with legacy sendMessage", () => {
  it("reproduces the exact yields + callback order + StreamedResponse", async () => {
    const networkClient = fakeNetworkClient(() =>
      sseFromEvents([
        {
          type: "message_start",
          messageId: "msg_c",
          modelId: "oauth-model",
          initialUsage: { inputTokens: 5, outputTokens: 0 },
        },
        { type: "thinking_start", index: 0 },
        { type: "thinking_delta", index: 0, text: "let me think " },
        { type: "thinking_delta", index: 0, text: "about it" },
        { type: "thinking_signature", index: 0, signature: "sig-xyz" },
        { type: "thinking_stop", index: 0 },
        { type: "text_start", index: 1 },
        { type: "text_delta", index: 1, text: "Hello " },
        { type: "text_delta", index: 1, text: "world" },
        { type: "text_stop", index: 1 },
        { type: "tool_use_start", index: 2, id: "tu_1", name: "Bash" },
        { type: "tool_use_input_delta", index: 2, partialJson: '{"command":' },
        { type: "tool_use_input_delta", index: 2, partialJson: '"ls"}' },
        { type: "tool_use_stop", index: 2 },
        {
          type: "message_delta",
          stopReason: "tool_use",
          stopSequence: null,
          usage: { inputTokens: 5, outputTokens: 2 },
        },
        { type: "message_stop" },
      ]),
    )

    const auth: AuthResult = { type: "oauth", token: "test-token" }
    const log: string[] = []
    const yields: string[] = []

    const gen = canonicalSendFn({
      auth,
      messages,
      model: "oauth-model",
      stream: true,
      networkClient,
      onBlockEdge: ({ block, edge }) => {
        log.push(`${block}:${edge}`)
      },
      onThinkingDelta: (t) => {
        log.push(`thinkingDelta:${t}`)
      },
    })

    let res: IteratorResult<string, StreamedResponse>
    // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
    while (!(res = await gen.next()).done) {
      yields.push(res.value)
      log.push(`yield:${res.value}`)
    }
    const response = res.value

    // Identical to the Phase-0 legacy golden:
    expect(yields.join("")).toBe("Hello world")
    expect(log).toEqual([
      "thinking:start",
      "thinkingDelta:let me think ",
      "thinkingDelta:about it",
      "thinking:stop",
      "text:start",
      "yield:Hello ",
      "yield:world",
      "text:stop",
    ])
    expect(response.stopReason).toBe("tool_use")
    expect(response.text).toBe("Hello world")
    expect(response.blocks).toEqual([
      { type: "thinking", thinking: "let me think about it", signature: "sig-xyz" },
      { type: "text", text: "Hello world" },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
    ])
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Cross-provider dispatch + per-provider auth (the migration payoff)
// ---------------------------------------------------------------------------

describe("canonicalSendFn — cross-provider dispatch + per-provider auth (the migration payoff)", () => {
  const ANTHROPIC_SECRET = "oauth-secret-DO-NOT-LEAK"
  const auth: AuthResult = { type: "oauth", token: ANTHROPIC_SECRET }
  let dir: string
  // Captured per test, NOT at describe-collection time: the module `beforeAll`
  // sandbox (and its seeded anthropic credential) is set AFTER collection, so a
  // collection-time capture would restore the pre-sandbox path and strand every
  // later suite on the real store.
  let prevAuthFile: string | undefined

  beforeEach(() => {
    prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
    dir = mkdtempSync(join(tmpdir(), "minimal-agent-auth-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    resetDefaultAuthStoreForTests()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
    else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
    resetDefaultAuthStoreForTests()
  })

  it("authenticates a key-model request with the stored key-prov auth, NOT the oauth-prov token", async () => {
    writeStoredOpenAIKey("sk-key-prov-real-key")
    let seenUrl = ""
    let seenAuth = ""
    const networkClient = fakeNetworkClient((req) => {
      seenUrl = req.url
      seenAuth = req.headers?.authorization ?? ""
      return sseFromEvents(pongEvents())
    })
    const yields: string[] = []
    const gen = canonicalSendFn({ auth, messages, model: "key-model", stream: true, networkClient })
    let res: IteratorResult<string, unknown>
    // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
    while (!(res = await gen.next()).done) yields.push(res.value as string)
    const response = res.value as { text: string; stopReason: string | null }

    expect(seenUrl).toBe(testProviderUrl("key-prov"))
    expect(seenAuth).toBe("Bearer sk-key-prov-real-key")
    expect(seenAuth).not.toContain(ANTHROPIC_SECRET)
    expect(yields.join("")).toBe("pong")
    expect(response.text).toBe("pong")
    expect(response.stopReason).toBe("end_turn")
  }, 15_000)

  it("throws a clear stored-credential error when no provider auth exists", async () => {
    let reached = false
    const networkClient = fakeNetworkClient(() => {
      reached = true
      return sseFromEvents(pongEvents())
    })
    const gen = canonicalSendFn({
      auth,
      messages,
      model: "key-model-2",
      stream: true,
      networkClient,
    })
    let caught = ""
    try {
      await gen.next()
    } catch (e) {
      caught = (e as Error).message
    }
    expect(caught).toContain('no credentials for provider "key-prov"')
    expect(caught).toContain("minimal-agent provider key-prov login")
    expect(caught).not.toContain("KEY_PROV_API_KEY")
    expect(caught).not.toContain("apiKeys.key-prov")
    expect(reached).toBe(false)
  }, 15_000)

  it("honors the MINIMAL_AGENT_TEST_AUTH seam with the caller credential (empty store)", async () => {
    // Startup returns a synthetic test token under this seam without reading
    // the store; the send must not then demand a real stored credential.
    const prevTestAuth = process.env.MINIMAL_AGENT_TEST_AUTH
    process.env.MINIMAL_AGENT_TEST_AUTH = "1"
    let seenAuth = ""
    const networkClient = fakeNetworkClient((req) => {
      seenAuth = req.headers?.authorization ?? ""
      return sseFromEvents(pongEvents())
    })
    try {
      const gen = canonicalSendFn({
        auth: { type: "oauth", token: "test-token" },
        messages,
        model: "key-model-2",
        stream: true,
        networkClient,
      })
      while (!(await gen.next()).done) {
        // drain
      }
    } finally {
      if (prevTestAuth === undefined) delete process.env.MINIMAL_AGENT_TEST_AUTH
      else process.env.MINIMAL_AGENT_TEST_AUTH = prevTestAuth
    }
    expect(seenAuth).toBe("Bearer test-token")
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Provider auth source: host auth store only
// ---------------------------------------------------------------------------

describe("canonicalSendFn — provider auth source is host store only", () => {
  const ANTHROPIC_SECRET = "oauth-secret-DO-NOT-LEAK"
  const auth: AuthResult = { type: "oauth", token: ANTHROPIC_SECRET }

  let dir: string
  let cfgPath: string
  // Captured per test (see the cross-provider suite above for why).
  let prevConfig: string | undefined
  let prevOpenAI: string | undefined
  let prevAuthFile: string | undefined

  beforeEach(() => {
    prevConfig = process.env.MINIMAL_AGENT_CONFIG
    prevOpenAI = process.env.KEY_PROV_API_KEY
    prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
    dir = mkdtempSync(join(tmpdir(), "minimal-agent-auth-store-"))
    cfgPath = join(dir, "config.jsonc")
    process.env.MINIMAL_AGENT_CONFIG = cfgPath
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    resetDefaultAuthStoreForTests()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevConfig === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevConfig
    if (prevOpenAI === undefined) delete process.env.KEY_PROV_API_KEY
    else process.env.KEY_PROV_API_KEY = prevOpenAI
    if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
    else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
    resetDefaultAuthStoreForTests()
  })

  it("ignores config apiKeys.key-prov and uses the stored provider key", async () => {
    process.env.KEY_PROV_API_KEY = "sk-from-env"
    writeFileSync(cfgPath, JSON.stringify({ apiKeys: { "key-prov": "sk-from-config" } }))
    writeStoredOpenAIKey("sk-from-store")

    let seenAuth = ""
    const networkClient = fakeNetworkClient((req) => {
      seenAuth = req.headers?.authorization ?? ""
      return sseFromEvents(pongEvents())
    })
    const gen = canonicalSendFn({ auth, messages, model: "key-model", stream: true, networkClient })
    while (!(await gen.next()).done) {
      // drain
    }

    expect(seenAuth).toBe("Bearer sk-from-store")
    expect(seenAuth).not.toContain(ANTHROPIC_SECRET)
  }, 15_000)

  it("ignores KEY_PROV_API_KEY when no stored provider key exists", async () => {
    process.env.KEY_PROV_API_KEY = "sk-from-env"
    writeFileSync(cfgPath, JSON.stringify({ apiKeys: { "key-prov": "sk-from-config" } }))

    let reached = false
    const networkClient = fakeNetworkClient((_req) => {
      reached = true
      return sseFromEvents(pongEvents())
    })
    const gen = canonicalSendFn({
      auth,
      messages,
      model: "key-model-2",
      stream: true,
      networkClient,
    })
    let caught = ""
    try {
      await gen.next()
    } catch (e) {
      caught = (e as Error).message
    }

    expect(caught).toContain('no credentials for provider "key-prov"')
    expect(caught).not.toContain(ANTHROPIC_SECRET)
    expect(reached).toBe(false)
  }, 15_000)

  it("ignores config apiKeys.key-prov when store and env are empty", async () => {
    delete process.env.KEY_PROV_API_KEY
    writeFileSync(cfgPath, JSON.stringify({ apiKeys: { "key-prov": "sk-from-config" } }))

    let reached = false
    const networkClient = fakeNetworkClient((_req) => {
      reached = true
      return sseFromEvents(pongEvents())
    })
    const gen = canonicalSendFn({ auth, messages, model: "key-model", stream: true, networkClient })
    let caught = ""
    try {
      await gen.next()
    } catch (e) {
      caught = (e as Error).message
    }

    expect(caught).toContain('no credentials for provider "key-prov"')
    expect(reached).toBe(false)
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Middleware actually activates through the composed transport
// ---------------------------------------------------------------------------

describe("canonicalSendFn — resilience middleware is wired end-to-end", () => {
  it("propagates a truncated stream: watchdog trips → error yields to caller (never retries)", async () => {
    // stream_truncated is NOT retryable (it signals an intentional model
    // decision, not a transient network failure). The partial text must
    // still be yielded before the error propagates.
    const origRandom = Math.random
    Math.random = () => 0 // instant backoff (shouldn't matter -- no retry)
    let calls = 0
    const networkClient = fakeNetworkClient(() => {
      calls++
      // Truncated: streams a partial text block then closes WITHOUT
      // message_stop → the watchdog throws stream_truncated.
      return sseFromEvents([
        {
          type: "message_start",
          messageId: "m1",
          modelId: "oauth-model",
          initialUsage: { inputTokens: 1, outputTokens: 0 },
        },
        { type: "text_start", index: 0 },
        { type: "text_delta", index: 0, text: "partial" },
      ])
    })

    const auth: AuthResult = { type: "oauth", token: "test-token" }
    const yields: string[] = []
    let caught: Error | undefined
    try {
      const gen = canonicalSendFn({
        auth,
        messages,
        model: "oauth-model",
        stream: true,
        networkClient,
      })
      for await (const chunk of gen) yields.push(chunk)
    } catch (err) {
      caught = err as Error
    } finally {
      Math.random = origRandom
    }

    // The partial text was yielded before the truncation.
    expect(yields.join("")).toBe("partial")
    // The error propagated (not retried forever).
    expect(caught).toBeDefined()
    expect(caught?.message).toContain("server truncated")
    // Only one attempt was made.
    expect(calls).toBe(1)
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Usage / quota broadcast on the same buses as the legacy client
// ---------------------------------------------------------------------------

describe("canonicalSendFn — quota footer refresh", () => {
  it("emits quota.headersReceived after a completed send so the footer repaints this turn", async () => {
    // Post-Wave-G regression: the provider adapter caches its rate-limit
    // headers in its own sibling-repo module during run(); core can't reach
    // that cache, so it can't broadcast the headers. But the quota-status slot
    // ignores the event payload and re-reads the provider cache, so the host
    // only needs to POKE the bus once the turn completes. Without this the
    // footer's 5h/7d windows only refresh on the 5-minute heartbeat.
    // The poke goes to the send's `pluginEvents` port (spec S28), never to
    // the module plugin bus.
    const bus = new EventBus()
    const globalBus = new EventBus()
    setGlobalEventBus(globalBus)
    let received = 0
    let globalReceived = 0
    const dispose = bus.on(QUOTA_HEADERS_RECEIVED, () => {
      received++
    })
    const disposeGlobal = globalBus.on(QUOTA_HEADERS_RECEIVED, () => {
      globalReceived++
    })
    try {
      const networkClient = fakeNetworkClient(() => sseFromEvents(pongEvents()))
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const gen = canonicalSendFn({
        auth,
        messages,
        model: "oauth-model",
        stream: true,
        networkClient,
        pluginEvents: bus,
      })
      while (!(await gen.next()).done) {
        // drain
      }
      // Bus delivery is microtask-deferred; let it drain before asserting.
      await Promise.resolve()
      await Promise.resolve()
      expect(received).toBeGreaterThanOrEqual(1)
      expect(globalReceived).toBe(0)
    } finally {
      dispose()
      disposeGlobal()
      setGlobalEventBus(null)
    }
  }, 15_000)
})

describe("canonicalSendFn — usage broadcast", () => {
  it("records the message_start footprint on the session-token bus", async () => {
    clearSessionTokens()
    const networkClient = fakeNetworkClient(() =>
      sseFromEvents([
        {
          type: "message_start",
          messageId: "mu",
          modelId: "oauth-model",
          initialUsage: { inputTokens: 42, outputTokens: 0 },
        },
        { type: "text_start", index: 0 },
        { type: "text_delta", index: 0, text: "hi" },
        { type: "text_stop", index: 0 },
        {
          type: "message_delta",
          stopReason: "end_turn",
          usage: { inputTokens: 42, outputTokens: 1 },
        },
        { type: "message_stop" },
      ]),
    )
    const auth: AuthResult = { type: "oauth", token: "test-token" }
    const gen = canonicalSendFn({
      auth,
      messages,
      model: "oauth-model",
      stream: true,
      networkClient,
    })
    while (!(await gen.next()).done) {
      // drain
    }
    expect(getSessionTokens().input).toBe(42)
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Full-stack consumption: a multi-block stream through the WHOLE transport
// (run → adapter → SSE → watchdog → bridge → retry), dispatched by owner.
// The real Anthropic capture replay lives in plugins/llm-anthropic
// (translateAnthropicStream's fixture test) — adapter wire parsing is the
// plugin's contract, owner dispatch + stream consumption is core's.
// ---------------------------------------------------------------------------

describe("canonicalSendFn — multi-block stream through the whole canonical stack", () => {
  it("consumes a thinking+text stream end-to-end and hits the owning provider's endpoint", async () => {
    let seenUrl = ""
    const networkClient = fakeNetworkClient((req) => {
      seenUrl = req.url
      return sseFromEvents([
        {
          type: "message_start",
          messageId: "msg_full",
          modelId: "oauth-model",
          initialUsage: { inputTokens: 9, outputTokens: 0 },
        },
        { type: "thinking_start", index: 0 },
        { type: "thinking_delta", index: 0, text: "plan the answer" },
        { type: "thinking_signature", index: 0, signature: "sig-full" },
        { type: "thinking_stop", index: 0 },
        { type: "text_start", index: 1 },
        { type: "text_delta", index: 1, text: "The answer " },
        { type: "text_delta", index: 1, text: "is 42." },
        { type: "text_stop", index: 1 },
        {
          type: "message_delta",
          stopReason: "end_turn",
          usage: { inputTokens: 9, outputTokens: 5 },
        },
        { type: "message_stop" },
      ])
    })
    const auth: AuthResult = { type: "oauth", token: "oauth-test" }
    const yields: string[] = []
    let res: IteratorResult<string, StreamedResponse>
    const gen = canonicalSendFn({
      auth,
      messages,
      model: "oauth-model",
      stream: true,
      networkClient,
    })
    // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
    while (!(res = await gen.next()).done) yields.push(res.value)
    const response = res.value

    // Dispatched to the endpoint of the provider that owns the model.
    expect(seenUrl).toBe(testProviderUrl("oauth-prov"))
    // The stream was consumed: text streamed, a text block accumulated,
    // and the end_turn stop reason surfaced.
    expect(yields.join("").length).toBeGreaterThan(0)
    expect(response.blocks.some((b) => b.type === "text")).toBe(true)
    expect(response.stopReason).toBe("end_turn")
  }, 15_000)
})

// ---------------------------------------------------------------------------
// --debug request dump: the canonical transport must emit the same request
// dump the legacy sendMessage did, now as Debug diagnostics on the bus
// (spec S25: the engine never writes stderr itself). Regression: when the default
// transport flipped to canonicalSendFn, the dump (model/max_tokens/messages/
// tools) was lost because it lived only in client.ts's sendMessage, so
// `--debug` printed nothing for a normal conversation.
// ---------------------------------------------------------------------------

describe("canonicalSendFn — --debug request dump", () => {
  it("emits the request dump as diagnostics when DEBUG=1", async () => {
    const prevDebug = process.env.DEBUG
    process.env.DEBUG = "1"
    const lines: string[] = []
    const off = getDiagnosticBus().on("*", (e) => {
      if (e.source === "transport.request-dump") lines.push(e.message)
    })
    try {
      const networkClient = fakeNetworkClient(() => sseFromEvents(pongEvents()))
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const gen = canonicalSendFn({
        auth,
        messages,
        model: "oauth-model",
        stream: true,
        maxTokens: 4096,
        networkClient,
        tools: [{ name: "Bash", description: "run a shell command", input_schema: {} }],
      })
      while (!(await gen.next()).done) {
        // drain
      }
    } finally {
      off()
      if (prevDebug === undefined) delete process.env.DEBUG
      else process.env.DEBUG = prevDebug
    }

    const out = lines.join("\n")
    // The dump names the model, the token budget, the message count, and the
    // tool set — the signal a `--debug` user expects before each request.
    expect(out).toContain("oauth-model")
    expect(out).toContain("max_tokens")
    expect(out).toContain("4096")
    expect(out).toContain("message(s)")
    expect(out).toContain("Bash")
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Status-label lifecycle: "Sending request" → "Receiving stream" on first event.
// Regression: canonical-send.ts never updated the label, so it stayed "Sending
// request" even once response bytes were flowing in — the ↑/↓ arrow correctly
// flipped to ↓ but the label was misleading.
// ---------------------------------------------------------------------------

describe("canonicalSendFn — status phase lifecycle", () => {
  it("transitions phase from 'sending' to 'receiving' on message_start (spec S23)", async () => {
    // The engine never reads a global status bus (S23): the send reports
    // through an injected StatusPort, phase codes only, no label.
    const phases: StatusFields["phase"][] = []
    const statusPort: StatusPort = {
      open: (fields) => {
        phases.push(fields.phase)
        return {
          update: (next) => phases.push(next.phase),
          updateActivity: () => {},
          clear: () => {},
        }
      },
    }

    const networkClient = fakeNetworkClient(() => sseFromEvents(pongEvents()))
    const auth: AuthResult = { type: "oauth", token: "test-token" }
    const gen = canonicalSendFn({
      auth,
      messages,
      model: "oauth-model",
      stream: true,
      networkClient,
      statusPort,
    })
    while (!(await gen.next()).done) {
      // drain
    }

    expect(phases).toEqual(["sending", "receiving"])
  }, 5_000)

  it("moves to 'receiving' on the first body chunk, before message_start arrives", async () => {
    // Regression (2026-11-15): Cursor sends framing frames for seconds and
    // holds `message_start` back until the first content event, so the row
    // read "Sending request ↓ 39.3 KB · 20.9 KB/s": the arrow was right (bytes
    // were coming down), the label was not. The first response byte of the
    // claimed stream is the fact that the request is now receiving.
    const phases: StatusFields["phase"][] = []
    let phasesBeforeContent: StatusFields["phase"][] | null = null
    const statusPort: StatusPort = {
      open: (fields) => {
        phases.push(fields.phase)
        return {
          update: (next) => phases.push(next.phase),
          updateActivity: () => {},
          clear: () => {},
        }
      },
    }
    const enc = new TextEncoder()
    const networkClient = fakeNetworkClient(
      () =>
        new NetworkResponse({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          transport: { id: "fake", protocol: "h2" },
          body: new ReadableStream<Uint8Array>({
            async pull(c) {
              if (phasesBeforeContent === null) {
                // Framing bytes the adapter does not turn into an event.
                phasesBeforeContent = []
                c.enqueue(enc.encode(": framing\n\n"))
                return
              }
              // Second pull: runs as soon as the tap dequeues the framing
              // chunk, so let the tap's lifecycle callback run first.
              await new Promise((r) => setTimeout(r, 10))
              phasesBeforeContent = [...phases]
              for (const ev of pongEvents()) c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n`))
              c.close()
            },
          }),
        }),
    )
    const gen = canonicalSendFn({
      auth: { type: "oauth", token: "test-token" },
      messages,
      model: "oauth-model",
      stream: true,
      networkClient,
      statusPort,
    })
    while (!(await gen.next()).done) {
      // drain
    }
    expect(phasesBeforeContent as StatusFields["phase"][] | null).toEqual(["sending", "receiving"])
    // message_start does not repeat the transition.
    expect(phases).toEqual(["sending", "receiving"])
  }, 5_000)

  it("publishes block facts on the live activity: thinking → tool-input → stream", async () => {
    // Research 10404ddc: a silent thinking block read as "⋯ stalled" because
    // the host only saw bytes. The send now publishes the open block (data,
    // no label) from the same tracker the watchdog budgets on.
    const patches: StatusActivity[] = []
    const statusPort: StatusPort = {
      open: () => ({
        update: () => {},
        updateActivity: (a) => patches.push({ ...a }),
        clear: () => {},
      }),
    }
    const networkClient = fakeNetworkClient(() =>
      sseFromEvents([
        {
          type: "message_start",
          messageId: "msg_blocks",
          modelId: "oauth-model",
          initialUsage: { inputTokens: 1, outputTokens: 0 },
        },
        { type: "thinking_start", index: 0 },
        { type: "ping" },
        { type: "thinking_signature", index: 0, signature: "sig" },
        { type: "thinking_stop", index: 0 },
        { type: "tool_use_start", index: 1, id: "toolu_1", name: "Write" },
        { type: "tool_use_input_delta", index: 1, partialJson: '{"path":"a"}' },
        { type: "tool_use_stop", index: 1 },
        {
          type: "message_delta",
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 3 },
        },
        { type: "message_stop" },
      ]),
    )
    const gen = canonicalSendFn({
      auth: { type: "oauth", token: "test-token" },
      messages,
      model: "oauth-model",
      stream: true,
      networkClient,
      statusPort,
    })
    while (!(await gen.next()).done) {
      // drain
    }

    const block = patches.filter((p) => p.phase !== undefined)
    // Attempt start resets to `connect`, then each phase change in order.
    const order = block.map((p) => p.phase).filter((p, i, a) => i === 0 || p !== a[i - 1])
    expect(order).toEqual(["connect", "stream", "thinking", "stream", "tool-input", "stream"])

    const thinking = block.find((p) => p.phase === "thinking")
    expect(thinking?.idleBudgetMs).toBe(DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS)
    expect(thinking?.toolName).toBeNull()
    expect(typeof thinking?.phaseStartedAt).toBe("number")
    expect(typeof thinking?.lastContentAt).toBe("number")

    const tool = block.find((p) => p.phase === "tool-input")
    expect(tool?.toolName).toBe("Write")
    expect(tool?.idleBudgetMs).toBe(DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS)

    const last = block[block.length - 1]
    expect(last?.phase).toBe("stream")
    expect(last?.toolName).toBeNull()
    expect(last?.idleBudgetMs).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    // Data only: core never sends a label or a verdict on the activity.
    for (const p of patches) expect(Object.keys(p)).not.toContain("label")
  }, 5_000)
})

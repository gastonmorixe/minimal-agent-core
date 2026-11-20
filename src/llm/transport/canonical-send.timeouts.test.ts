/**
 * Watchdog limits through the canonical transport: an explicit `SendOptions`
 * value, then env, then the default (`stream-timeouts.ts`). The pre-stream
 * budgets are read from the `budget-ms` field of `api.stream-stalled`; the
 * test moves the system clock forward so a stall trips at the next 1 s tick.
 *
 * @module llm/transport/canonical-send.timeouts.test
 */

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import type { LogEvent } from "../../bus/diagnostic-bus.ts"
import type { StatusActivity, StatusHandle } from "../../bus/status.ts"
import type { StatusPort } from "../../bus/status-port.ts"
import { createDiagnostics, type Diagnostics } from "../../diagnostics/hub.ts"
import { NetworkClient, NetworkResponse, type NetworkTransport } from "../../network/index.ts"
import { clearSessionTokens } from "../../session/session-tokens.ts"
import type { CanonicalEvent } from "../canonical-events.ts"
import type { Message } from "../messages.ts"
import { registerProvider } from "../model-registry.ts"
import { registerTestProvider, sseBodyFromEvents } from "../test-fixtures.ts"

import { bindPrimaryStreamRequest, canonicalAttemptFn, canonicalSendFn } from "./canonical-send.ts"
import { preStreamStreaks } from "./pre-stream-streak.ts"
import {
  RESPONSE_HEADERS_TIMEOUT_ENV,
  resetStreamTimeoutEnvReports,
  SILENT_BLOCK_IDLE_TIMEOUT_ENV,
  STREAM_IDLE_TIMEOUT_ENV,
} from "./stream-timeouts.ts"
import { DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "./watchdog.ts"

/** Provider-native auth: the send uses it as given, with no auth-store read. */
const PROVIDER_AUTH: AuthResult = { type: "provider", auth: { kind: "oauth", token: "t" } }

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

function fakeNetworkClient(
  handler: (
    req: Parameters<NetworkTransport["request"]>[0],
  ) => Promise<NetworkResponse> | NetworkResponse,
): NetworkClient {
  const transport: NetworkTransport = { id: "fake", request: async (req) => handler(req) }
  return new NetworkClient({ primary: transport })
}

function sseFromEvents(events: CanonicalEvent[]): NetworkResponse {
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    transport: { id: "fake", protocol: "h2" },
    body: sseBodyFromEvents(events),
  })
}

afterEach(() => {
  clearSessionTokens()
  setSystemTime()
  preStreamStreaks.reset()
})

/** A response body that never sends a byte, and errors when the request aborts. */
function silentBody(signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      const abort = (): void => c.error(Object.assign(new Error("aborted"), { name: "AbortError" }))
      if (signal?.aborted) return abort()
      signal?.addEventListener("abort", abort, { once: true })
    },
  })
}

/**
 * Register a provider whose stream POST goes to `url` (the test fixture
 * provider always posts to a remote `.invalid` host).
 */
function registerUrlProvider(id: string, model: string, url: string): void {
  const { adapter } = registerTestProvider({ id, models: [{ id: model }] })
  registerProvider({
    ...adapter,
    async *run(req, _model, ctx) {
      const client = ctx.networkClient as NetworkClient
      const response = await client.request({
        label: "url-provider.stream",
        method: "POST",
        url,
        body: "{}",
        ...(req.signal ? { signal: req.signal } : {}),
      })
      if (!response.body) throw new Error("no body")
      const reader = response.body.getReader()
      while (!(await reader.read()).done) {
        // A real codec would parse here; these tests never get a byte.
      }
    },
  })
}

/** The stall facts of `api.stream-stalled`. */
interface StallFacts {
  phase?: string
  subPhase?: string
  budgetMs?: number
}

/**
 * Run one attempt against a server that never sends a body byte. At the
 * wire call the clock jumps 25 min forward (below the 30 min hard limit),
 * so the pre-stream check trips at the next 1 s tick and reports the
 * budget in force. With `headers`, the response headers arrive first.
 */
async function preStreamStall(opts: {
  model: string
  headers?: boolean
  responseHeadersTimeoutMs?: number
}): Promise<StallFacts> {
  const events: LogEvent[] = []
  const diagnostics: Diagnostics = createDiagnostics({ emit: (e) => events.push(e) })
  const networkClient = fakeNetworkClient((req) => {
    setSystemTime(new Date(Date.now() + 25 * 60_000))
    if (opts.headers) {
      return new NetworkResponse({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        transport: { id: "fake", protocol: "h2" },
        body: silentBody(req.signal),
      })
    }
    return new Promise<NetworkResponse>((_resolve, reject) => {
      const abort = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
      if (req.signal?.aborted) return abort()
      req.signal?.addEventListener("abort", abort, { once: true })
    })
  })
  let caught: unknown
  try {
    const gen = canonicalAttemptFn({
      auth: PROVIDER_AUTH,
      messages,
      model: opts.model,
      stream: true,
      networkClient,
      diagnostics,
      ...(opts.responseHeadersTimeoutMs !== undefined
        ? { responseHeadersTimeoutMs: opts.responseHeadersTimeoutMs }
        : {}),
    })
    while (!(await gen.next()).done) {
      // drain
    }
  } catch (err) {
    caught = err
  } finally {
    setSystemTime()
  }
  expect((caught as { streamErrorType?: string } | undefined)?.streamErrorType).toBe("stream_idle")
  const data = events.find((e) => e.source === "api.stream-stalled")?.structuredData
  return {
    phase: data?.phase as string | undefined,
    subPhase: data?.["stall-sub-phase"] as string | undefined,
    budgetMs: data?.["budget-ms"] as number | undefined,
  }
}

// ---------------------------------------------------------------------------
// Watchdog limits: explicit SendOptions > env > default
// ---------------------------------------------------------------------------

describe("canonicalSendFn — watchdog limits", () => {
  const ENV_KEYS = [
    STREAM_IDLE_TIMEOUT_ENV,
    SILENT_BLOCK_IDLE_TIMEOUT_ENV,
    RESPONSE_HEADERS_TIMEOUT_ENV,
  ] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    resetStreamTimeoutEnvReports()
    registerTestProvider({ id: "timeouts-prov", models: [{ id: "timeouts-model" }] })
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  /** A thinking block; with `ping`, a keepalive arrives inside the block. */
  function thinkingEvents(modelId: string, ping: boolean): CanonicalEvent[] {
    return [
      {
        type: "message_start",
        messageId: "msg_budget",
        modelId,
        initialUsage: { inputTokens: 1, outputTokens: 0 },
      },
      // A ping before the block proves nothing (a role-only first chunk).
      { type: "ping" },
      { type: "thinking_start", index: 0 },
      // A ping inside the open block proves a periodic keepalive.
      ...(ping ? [{ type: "ping" } as const] : []),
      { type: "thinking_signature", index: 0, signature: "sig" },
      { type: "thinking_stop", index: 0 },
      {
        type: "message_delta",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { type: "message_stop" },
    ]
  }

  /** Send once and return the idle budgets the send published, per block phase. */
  async function budgets(
    model: string,
    extra: { streamIdleTimeoutMs?: number } = {},
    ping = true,
  ): Promise<{ thinking?: number; stream?: number }> {
    const patches: StatusActivity[] = []
    const statusPort: StatusPort = {
      open: () => ({
        update: () => {},
        updateActivity: (a) => patches.push({ ...a }),
        clear: () => {},
      }),
    }
    const gen = canonicalSendFn({
      auth: PROVIDER_AUTH,
      messages,
      model,
      stream: true,
      networkClient: fakeNetworkClient(() => sseFromEvents(thinkingEvents(model, ping))),
      statusPort,
      ...extra,
    })
    while (!(await gen.next()).done) {
      // drain
    }
    return {
      // The last thinking patch: the budget after the in-block ping.
      thinking: patches.findLast((p) => p.phase === "thinking")?.idleBudgetMs,
      stream: patches.findLast((p) => p.phase === "stream")?.idleBudgetMs,
    }
  }

  it("uses 90 s silent-block idle after an in-block ping, 300 s with no in-block ping", async () => {
    expect((await budgets("timeouts-model", {}, true)).thinking).toBe(90_000)
    expect((await budgets("timeouts-model", {}, false)).thinking).toBe(
      DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS,
    )
  }, 5_000)

  it("env overrides the silent-block and idle limits; a bad env value keeps the default", async () => {
    process.env[SILENT_BLOCK_IDLE_TIMEOUT_ENV] = "150000"
    process.env[STREAM_IDLE_TIMEOUT_ENV] = "45000"
    const good = await budgets("timeouts-model")
    expect(good.thinking).toBe(150_000)
    expect(good.stream).toBe(45_000)

    process.env[SILENT_BLOCK_IDLE_TIMEOUT_ENV] = "soon"
    process.env[STREAM_IDLE_TIMEOUT_ENV] = "0"
    const bad = await budgets("timeouts-model")
    expect(bad.thinking).toBe(90_000)
    expect(bad.stream).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
  }, 5_000)

  it("an explicit SendOptions value (wrap-up) wins over env", async () => {
    process.env[STREAM_IDLE_TIMEOUT_ENV] = "45000"
    expect((await budgets("timeouts-model", { streamIdleTimeoutMs: 10_000 })).stream).toBe(10_000)
  }, 5_000)

  it("applies the env pre-stream base (raised to the 5 s floor) to a hanging request", async () => {
    process.env[RESPONSE_HEADERS_TIMEOUT_ENV] = "500"
    const stall = await preStreamStall({ model: "timeouts-model" })
    expect(stall.phase).toBe("pre-stream")
    expect(stall.budgetMs).toBe(5000)
  }, 15_000)
})

describe("canonicalAttemptFn — pre-stream budget from the request URL", () => {
  beforeEach(() => {
    delete process.env[RESPONSE_HEADERS_TIMEOUT_ENV]
    resetStreamTimeoutEnvReports()
    preStreamStreaks.reset()
    registerUrlProvider("remote-url-prov", "remote-url-model", "https://api.example.com/v1/x")
    registerUrlProvider("local-url-prov", "local-url-model", "http://localhost:8080/v1/x")
  })

  it("gives 60 s before the headers to a remote URL and 120 s to a localhost URL", async () => {
    const remote = await preStreamStall({ model: "remote-url-model" })
    expect(remote).toEqual({ phase: "pre-stream", subPhase: "pre-headers", budgetMs: 60_000 })
    preStreamStreaks.reset()
    const local = await preStreamStall({ model: "local-url-model" })
    expect(local).toEqual({ phase: "pre-stream", subPhase: "pre-headers", budgetMs: 120_000 })
  }, 15_000)

  it("gives 120 s once the headers arrived (the wait is prefill)", async () => {
    const stall = await preStreamStall({ model: "remote-url-model", headers: true })
    expect(stall).toEqual({ phase: "pre-stream", subPhase: "headers-wait-body", budgetMs: 120_000 })
  }, 15_000)

  it("doubles the pre-headers budget for each pre-stream retry, up to 240 s", async () => {
    const budgets: Array<number | undefined> = []
    for (let i = 0; i < 4; i++) {
      budgets.push((await preStreamStall({ model: "remote-url-model" })).budgetMs)
    }
    expect(budgets).toEqual([60_000, 120_000, 240_000, 240_000])
  }, 20_000)

  it("starts at the base budget again after the endpoint answered", async () => {
    await preStreamStall({ model: "remote-url-model" })
    // The body byte of a good attempt clears the streak.
    await preStreamStall({ model: "remote-url-model", headers: true })
    expect((await preStreamStall({ model: "remote-url-model" })).budgetMs).toBe(240_000)
    preStreamStreaks.reset()
    registerTestProvider({ id: "timeouts-prov", models: [{ id: "timeouts-model" }] })
    await preStreamStall({ model: "timeouts-model" })
    const ok = canonicalAttemptFn({
      auth: PROVIDER_AUTH,
      messages,
      model: "timeouts-model",
      stream: true,
      networkClient: fakeNetworkClient(() => sseFromEvents(okEvents("timeouts-model"))),
    })
    while (!(await ok.next()).done) {
      // drain
    }
    expect((await preStreamStall({ model: "timeouts-model" })).budgetMs).toBe(60_000)
  }, 20_000)

  it("keeps an explicit SendOptions value (wrap-up) fixed across retries and headers", async () => {
    for (let i = 0; i < 2; i++) {
      const stall = await preStreamStall({
        model: "remote-url-model",
        responseHeadersTimeoutMs: 10_000,
      })
      expect(stall.budgetMs).toBe(10_000)
    }
    const after = await preStreamStall({
      model: "remote-url-model",
      headers: true,
      responseHeadersTimeoutMs: 10_000,
    })
    expect(after.budgetMs).toBe(10_000)
  }, 20_000)

  it("grows an env base the same way", async () => {
    process.env[RESPONSE_HEADERS_TIMEOUT_ENV] = "30000"
    try {
      const a = await preStreamStall({ model: "local-url-model" })
      const b = await preStreamStall({ model: "local-url-model" })
      expect([a.budgetMs, b.budgetMs]).toEqual([30_000, 60_000])
    } finally {
      delete process.env[RESPONSE_HEADERS_TIMEOUT_ENV]
    }
  }, 15_000)
})

/** A short good stream. */
function okEvents(modelId: string): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "m_ok",
      modelId,
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    { type: "message_delta", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
    { type: "message_stop" },
  ]
}

describe("bindPrimaryStreamRequest — onRequest", () => {
  const statusHandle: StatusHandle = { update: () => {}, updateActivity: () => {}, clear: () => {} }
  const json = (): NetworkResponse =>
    new NetworkResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      transport: { id: "fake", protocol: "h2" },
      body: new Response("{}").body ?? undefined,
    })

  it("calls onRequest once for the primary POST and never for a side probe", async () => {
    const seen: string[] = []
    const { client, detach } = bindPrimaryStreamRequest(
      fakeNetworkClient((req) => (req.label.endsWith(".billing") ? json() : sseFromEvents([]))),
      { statusHandle, onRequest: (input) => seen.push(input.url) },
    )
    await client.request({ label: "x.billing", method: "POST", url: "https://b.example/q" })
    await client.request({ label: "x.stream", method: "POST", url: "https://a.example/s" })
    // The stream is claimed: a later POST does not call it again.
    await client.request({ label: "x.other", method: "POST", url: "https://a.example/t" })
    detach()
    expect(seen).toEqual(["https://a.example/s"])
  })

  it("calls onRequest twice when a non-stream POST comes before the stream POST", async () => {
    const seen: string[] = []
    const { client, detach } = bindPrimaryStreamRequest(
      fakeNetworkClient((req) => (req.url.endsWith("/token") ? json() : sseFromEvents([]))),
      { statusHandle, onRequest: (input) => seen.push(input.url) },
    )
    await client.request({ label: "x.auth", method: "POST", url: "https://a.example/token" })
    await client.request({ label: "x.stream", method: "POST", url: "https://a.example/s" })
    detach()
    expect(seen).toEqual(["https://a.example/token", "https://a.example/s"])
  })
})

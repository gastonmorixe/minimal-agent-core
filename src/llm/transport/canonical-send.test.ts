/**
 * End-to-end tests for the canonical transport (`canonicalSendFn`).
 *
 * These prove the Phase-1 claim: a transport that routes through the
 * canonical `run()` is observably interchangeable with the legacy
 * `sendMessage` behind `Agent.sendFn`, AND it dispatches non-Anthropic
 * models to the right provider (the whole point of the migration).
 *
 * - **Anthropic**: feed `canonicalSendFn` the SAME synthesized SSE as the
 *   Phase-0 golden (`client.transport-contract.test.ts`) and assert the
 *   identical observable surface : text-channel yields, lifecycle callback
 *   order, and the final `StreamedResponse` (blocks / text / stopReason).
 *
 * - **OpenAI**: replay the `chat-pong.sse` fixture and assert the request
 *   actually went to `https://api.openai.com/v1/chat/completions` (NOT
 *   Anthropic) and produced the expected text + stop reason. This is the
 *   proof that `--model gpt-*` reaches OpenAI through the agent's transport
 *   seam.
 *
 * Full retry / watchdog / 401 middleware is Phase 2; this is the raw path.
 *
 * @module llm/transport/canonical-send.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { beforeAll, describe, expect, it } from "bun:test"

import { bootstrapAnthropic } from "../../../plugins/llm-anthropic/adapter.ts"
import { bootstrapOpenAI } from "../../../plugins/llm-openai/adapter.ts"
import { CHAT_COMPLETIONS_URL } from "../../../plugins/llm-openai/wire-constants.ts"
import { type AuthResult, getAuth } from "../../auth.ts"
import type { Message, StreamedResponse } from "../../client/types.ts"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "../../network/index.ts"
import { clearSessionTokens, getSessionTokens } from "../../session-tokens.ts"

import { canonicalSendFn } from "./canonical-send.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeHandler = (req: NetworkRequest) => NetworkResponse | Promise<NetworkResponse>

function fakeNetworkClient(handler: FakeHandler): NetworkClient {
  const transport: NetworkTransport = { id: "fake", request: async (req) => handler(req) }
  return new NetworkClient({ primary: transport })
}

/** SSE response built from explicit event objects (one `data:` line each). */
function sseFromEvents(events: unknown[]): NetworkResponse {
  const enc = new TextEncoder()
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_cs_001" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n`))
        c.close()
      },
    }),
  })
}

/** SSE response from a raw fixture string (already in `data: ...` form). */
function sseFromString(raw: string): NetworkResponse {
  const enc = new TextEncoder()
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_cs_002" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(raw))
        c.close()
      },
    }),
  })
}

function openaiFixture(name: string): string {
  return readFileSync(
    join(import.meta.dir, "../../../plugins/llm-openai/__fixtures__", name),
    "utf-8",
  )
}

function anthropicFixture(name: string): string {
  return readFileSync(
    join(import.meta.dir, "../../../plugins/llm-anthropic/__fixtures__", name),
    "utf-8",
  )
}

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

// Register both provider adapters so `run()` can resolve their models.
beforeAll(() => {
  bootstrapAnthropic()
  bootstrapOpenAI()
})

// ---------------------------------------------------------------------------
// Anthropic: equivalence with the Phase-0 legacy golden
// ---------------------------------------------------------------------------

describe("canonicalSendFn — Anthropic equivalence with legacy sendMessage", () => {
  it("reproduces the exact yields + callback order + StreamedResponse", async () => {
    const networkClient = fakeNetworkClient(() =>
      sseFromEvents([
        {
          type: "message_start",
          message: { id: "msg_c", model: "claude-opus-4-8", usage: { input_tokens: 5 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "let me think " },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "about it" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig-xyz" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world" } },
        { type: "content_block_stop", index: 1 },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "tu_1", name: "Bash", input: {} },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"command":' },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '"ls"}' },
        },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null } },
        { type: "message_stop" },
      ]),
    )

    const auth: AuthResult = { type: "oauth", token: "test-token" }
    const log: string[] = []
    const yields: string[] = []

    const gen = canonicalSendFn({
      auth,
      messages,
      model: "claude-opus-4-8",
      stream: true,
      networkClient,
      onThinkingStart: () => {
        log.push("thinkingStart")
      },
      onThinkingDelta: (t) => {
        log.push(`thinkingDelta:${t}`)
      },
      onThinkingStop: () => {
        log.push("thinkingStop")
      },
      onTextStop: () => {
        log.push("textStop")
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
      "thinkingStart",
      "thinkingDelta:let me think ",
      "thinkingDelta:about it",
      "thinkingStop",
      "yield:Hello ",
      "yield:world",
      "textStop",
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
// OpenAI: the migration payoff — gpt-* dispatches to OpenAI, not Anthropic
// ---------------------------------------------------------------------------

describe("canonicalSendFn — OpenAI dispatch + per-provider auth (the migration payoff)", () => {
  // The host's single credential is the ANTHROPIC session. It must NEVER be
  // sent to OpenAI; OpenAI authenticates with OPENAI_API_KEY.
  const ANTHROPIC_SECRET = "anthropic-oauth-secret-DO-NOT-LEAK"
  const auth: AuthResult = { type: "oauth", token: ANTHROPIC_SECRET }

  it("authenticates a gpt-4o request with OPENAI_API_KEY, NOT the Anthropic token", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-openai-real-key"
    try {
      let seenUrl = ""
      let seenAuth = ""
      const networkClient = fakeNetworkClient((req) => {
        seenUrl = req.url
        seenAuth = req.headers?.authorization ?? ""
        return sseFromString(openaiFixture("chat-pong.sse"))
      })
      const yields: string[] = []
      const gen = canonicalSendFn({ auth, messages, model: "gpt-4o", stream: true, networkClient })
      let res: IteratorResult<string, unknown>
      // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
      while (!(res = await gen.next()).done) yields.push(res.value as string)
      const response = res.value as { text: string; stopReason: string | null }

      expect(seenUrl).toBe(CHAT_COMPLETIONS_URL)
      // The OpenAI key, never the Anthropic session token.
      expect(seenAuth).toBe("Bearer sk-openai-real-key")
      expect(seenAuth).not.toContain(ANTHROPIC_SECRET)
      // Legacy surface intact.
      expect(yields.join("")).toBe("pong")
      expect(response.text).toBe("pong")
      expect(response.stopReason).toBe("end_turn")
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  }, 15_000)

  it("throws a clear error naming OPENAI_API_KEY when it is unset (no Anthropic fallback)", async () => {
    const prev = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      let reached = false
      const networkClient = fakeNetworkClient(() => {
        reached = true
        return sseFromString(openaiFixture("chat-pong.sse"))
      })
      const gen = canonicalSendFn({ auth, messages, model: "gpt-5.5", stream: true, networkClient })
      let caught = ""
      try {
        await gen.next()
      } catch (e) {
        caught = (e as Error).message
      }
      expect(caught).toContain("OPENAI_API_KEY")
      // Never hit the network with a bogus/Anthropic credential.
      expect(reached).toBe(false)
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev
    }
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Middleware actually activates through the composed transport
// ---------------------------------------------------------------------------

describe("canonicalSendFn — resilience middleware is wired end-to-end", () => {
  it("recovers from a truncated stream: watchdog trips → retry → fresh attempt", async () => {
    const origRandom = Math.random
    Math.random = () => 0 // instant backoff
    let calls = 0
    const networkClient = fakeNetworkClient(() => {
      calls++
      if (calls === 1) {
        // Truncated: streams a partial text block then closes WITHOUT
        // message_stop → the watchdog throws stream_truncated.
        return sseFromEvents([
          {
            type: "message_start",
            message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 1 } },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
        ])
      }
      // Recovery: a complete stream.
      return sseFromEvents([
        {
          type: "message_start",
          message: { id: "m2", model: "claude-opus-4-8", usage: { input_tokens: 1 } },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
        { type: "message_stop" },
      ])
    })

    const auth: AuthResult = { type: "oauth", token: "test-token" }
    const yields: string[] = []
    let res: IteratorResult<string, StreamedResponse>
    const gen = canonicalSendFn({
      auth,
      messages,
      model: "claude-opus-4-8",
      stream: true,
      networkClient,
    })
    // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
    while (!(res = await gen.next()).done) yields.push(res.value)
    const response = res.value

    Math.random = origRandom

    expect(calls).toBe(2) // tripped once, recovered on retry
    const joined = yields.join("")
    expect(joined).toContain("partial")
    expect(joined).toContain("↳ stream stalled — retrying")
    expect(joined).toContain("recovered")
    // Final structured response is from the successful attempt.
    expect(response.text).toBe("recovered")
    expect(response.stopReason).toBe("end_turn")
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Usage / quota broadcast on the same buses as the legacy client
// ---------------------------------------------------------------------------

describe("canonicalSendFn — usage broadcast", () => {
  it("records the message_start footprint on the session-token bus", async () => {
    clearSessionTokens()
    const networkClient = fakeNetworkClient(() =>
      sseFromEvents([
        {
          type: "message_start",
          message: {
            id: "mu",
            model: "claude-opus-4-8",
            usage: { input_tokens: 42, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
        { type: "message_stop" },
      ]),
    )
    const auth: AuthResult = { type: "oauth", token: "test-token" }
    const gen = canonicalSendFn({
      auth,
      messages,
      model: "claude-opus-4-8",
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
// net-dbg parity: the canonical stack consumes a REAL captured Anthropic wire
// ---------------------------------------------------------------------------

describe("canonicalSendFn — real captured Anthropic wire (net-dbg parity)", () => {
  it("consumes the real Opus 4.8 capture end-to-end and hits the Anthropic endpoint", async () => {
    let seenUrl = ""
    const networkClient = fakeNetworkClient((req) => {
      seenUrl = req.url
      // The exact SSE captured from api.anthropic.com on 2026-05-28 (the
      // same fixture the adapter-level translateAnthropicStream test replays),
      // now driven through the WHOLE canonical transport stack.
      return sseFromString(anthropicFixture("conversation-opus48.res-body.sse"))
    })
    const auth: AuthResult = { type: "oauth", token: "oauth-test" }
    const yields: string[] = []
    let res: IteratorResult<string, StreamedResponse>
    const gen = canonicalSendFn({
      auth,
      messages,
      model: "claude-opus-4-8",
      stream: true,
      networkClient,
    })
    // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
    while (!(res = await gen.next()).done) yields.push(res.value)
    const response = res.value

    // Dispatched to the real Anthropic Messages endpoint.
    expect(seenUrl).toContain("api.anthropic.com")
    expect(seenUrl).toContain("/v1/messages")
    // The real stream was consumed: text streamed, a text block accumulated,
    // and the captured end_turn stop reason surfaced.
    expect(yields.join("").length).toBeGreaterThan(0)
    expect(response.blocks.some((b) => b.type === "text")).toBe(true)
    expect(response.stopReason).toBe("end_turn")
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Live (gated by E2E): Anthropic round-trip through the canonical stack.
// OpenRouter's live 402-ok case is covered in plugins/llm-openrouter.
// ---------------------------------------------------------------------------

describe("canonicalSendFn — live (gated by E2E)", () => {
  const skip = !process.env.E2E
  it.skipIf(skip)(
    "Anthropic haiku round-trip through the canonical stack (proves mode=all live)",
    async () => {
      const auth = await getAuth()
      const yields: string[] = []
      let res: IteratorResult<string, StreamedResponse>
      const gen = canonicalSendFn({
        auth,
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: PONG" }] }],
        model: "claude-haiku-4-5-20251001",
        maxTokens: 32,
        stream: true,
      })
      // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
      while (!(res = await gen.next()).done) yields.push(res.value)
      expect(yields.join("").toUpperCase()).toContain("PONG")
      expect(res.value.stopReason).toBeTruthy()
    },
    30_000,
  )
})

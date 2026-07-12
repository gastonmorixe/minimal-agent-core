/**
 * Full-stack, offline recovery tests for terminal-less stream closes.
 *
 * Strategy (Bun-native, no real network):
 * - Inject a fake {@link NetworkTransport} into {@link NetworkClient} (same
 *   pattern as `canonical-send.test.ts`). Bun's `mock()` records call counts.
 * - Drive the real transport onion: `withRetry(withAuthRefresh(watchdog→bridge→run))`
 *   via {@link canonicalSendFn}.
 * - Fake provider speaks **canonical-event SSE** through `registerTestProvider`
 *   (`.invalid` TLD sentinel URL — cannot leak to the public internet).
 *
 * This recreates the Grok incident shape without Grok wire events or sockets:
 * reasoning → complete tool → partial tool → stream_closed_without_terminal EOF.
 *
 * @module llm/transport/terminal-less-recovery.integration.test
 */

import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"

import { Agent } from "../../agent/agent.ts"
import type { TurnNotice } from "../../agent/turn-notice.ts"
import type { AuthResult } from "../../auth/auth.ts"
import {
  defaultAuthStore,
  resetDefaultAuthStoreForTests,
  type SecretBag,
} from "../../auth/auth-store.ts"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "../../network/index.ts"
import type { CanonicalEvent } from "../canonical-events.ts"
import type { Message } from "../messages.ts"
import type { ApiKeyAuthProvider } from "../provider-plugin.ts"
import { registerTestProvider, sseBodyFromEvents } from "../test-fixtures.ts"

import { canonicalSendFn } from "./canonical-send.ts"
import type { StreamedResponse } from "./types.ts"

// ---------------------------------------------------------------------------
// Fake network (Bun mock + NetworkClient primary transport)
// ---------------------------------------------------------------------------

function sseFromEvents(events: CanonicalEvent[], requestId = "req_termless"): NetworkResponse {
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": requestId },
    transport: { id: "fake", protocol: "h2" },
    body: sseBodyFromEvents(events),
  })
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

/** Incident-shaped stream: reasoning + complete tool + partial tool + terminal-less error. */
function incidentTerminalLessEvents(): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "resp_incident_1",
      modelId: "test-model-recovery",
      initialUsage: { inputTokens: 100, outputTokens: 0 },
    },
    { type: "thinking_start", index: 0 },
    { type: "thinking_delta", index: 0, text: "long live thinking — still going" },
    { type: "ping" },
    { type: "thinking_delta", index: 0, text: " … more reasoning" },
    { type: "thinking_stop", index: 0 },
    { type: "tool_use_start", index: 1, id: "call_complete", name: "Bash" },
    {
      type: "tool_use_input_delta",
      index: 1,
      partialJson: '{"command":"echo salvaged"}',
    },
    {
      type: "tool_use_stop",
      index: 1,
      input: { command: "echo salvaged" },
    },
    // Second tool never closes — incomplete; must not execute.
    { type: "tool_use_start", index: 2, id: "call_partial", name: "Bash" },
    { type: "tool_use_input_delta", index: 2, partialJson: '{"command":"rm -rf' },
    {
      type: "stream_error",
      retryable: true,
      category: "api",
      upstreamType: "stream_closed_without_terminal",
      cause: new Error("OpenAI Responses stream closed without a terminal event (truncated)"),
    },
  ]
}

function emptyTerminalLessEvents(): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "resp_empty",
      modelId: "test-model-recovery",
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    {
      type: "stream_error",
      retryable: true,
      category: "api",
      upstreamType: "stream_closed_without_terminal",
      cause: new Error("truncated empty"),
    },
  ]
}

function reasoningOnlyTerminalLessEvents(): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "resp_reason",
      modelId: "test-model-recovery",
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    { type: "thinking_start", index: 0 },
    { type: "thinking_delta", index: 0, text: "thinking hard" },
    { type: "ping" },
    { type: "thinking_stop", index: 0 },
    {
      type: "stream_error",
      retryable: true,
      category: "api",
      upstreamType: "stream_closed_without_terminal",
      cause: new Error("truncated after reasoning"),
    },
  ]
}

function cleanEndEvents(text: string): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "resp_ok",
      modelId: "test-model-recovery",
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

/** Mid-text terminal-less close (523dba62 post-ship shape): text, no tools. */
function textOnlyTerminalLessEvents(text: string): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "resp_text_termless",
      modelId: "test-model-recovery",
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    { type: "thinking_start", index: 0 },
    { type: "thinking_delta", index: 0, text: "drafting" },
    { type: "thinking_stop", index: 0 },
    { type: "text_start", index: 1 },
    { type: "text_delta", index: 1, text },
    {
      type: "stream_error",
      retryable: true,
      category: "api",
      upstreamType: "stream_closed_without_terminal",
      cause: new Error("truncated mid text"),
    },
  ]
}

async function drainSend(
  gen: AsyncGenerator<string, StreamedResponse, undefined>,
): Promise<{ yields: string[]; response: StreamedResponse }> {
  const yields: string[] = []
  let r: IteratorResult<string, StreamedResponse>
  // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
  while (!(r = await gen.next()).done) yields.push(r.value)
  return { yields, response: r.value }
}

// ---------------------------------------------------------------------------
// Auth / provider registration (sandbox real auth store)
// ---------------------------------------------------------------------------

const apiKeyAuth: ApiKeyAuthProvider = {
  serviceId: "test-recovery-api-key",
  displayName: "Test Recovery API Key",
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

const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
let moduleAuthDir: string

beforeAll(() => {
  moduleAuthDir = mkdtempSync(join(tmpdir(), "minimal-agent-termless-auth-"))
  process.env.MINIMAL_AGENT_AUTH_FILE = join(moduleAuthDir, "auth.jsonc")
  resetDefaultAuthStoreForTests()

  registerTestProvider({
    id: "test-recovery",
    models: [{ id: "test-model-recovery" }],
    apiKeyAuth,
  })
  const write = apiKeyAuth.buildCredential("sk-test-recovery")
  defaultAuthStore().set(write.serviceId, write.displayName, write.secrets as SecretBag)
})

afterAll(() => {
  if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
  else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
  resetDefaultAuthStoreForTests()
  if (moduleAuthDir) rmSync(moduleAuthDir, { recursive: true, force: true })
})

const auth: AuthResult = { type: "api-key", token: "sk-test-recovery" }
const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "do work" }] }]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("terminal-less recovery — full stack (fake NetworkClient, no real network)", () => {
  let origRandom: () => number

  beforeEach(() => {
    origRandom = Math.random
    Math.random = () => 0 // zero backoff for bounded retries
  })

  afterEach(() => {
    Math.random = origRandom
  })

  it("after complete+partial tools: salvages first only, one wire request, no body replay", async () => {
    const requestBodies: string[] = []
    const handler = mock((req: NetworkRequest) => {
      requestBodies.push(typeof req.body === "string" ? req.body : "")
      return sseFromEvents(incidentTerminalLessEvents())
    })
    const transport: NetworkTransport = {
      id: "fake",
      request: async (req) => handler(req),
    }
    const networkClient = new NetworkClient({ primary: transport })

    const { response } = await drainSend(
      canonicalSendFn({
        auth,
        messages,
        model: "test-model-recovery",
        selectedProviderId: "test-recovery",
        stream: true,
        networkClient,
      }),
    )

    // Critical: withRetry must NOT re-issue the POST after complete tools.
    expect(handler).toHaveBeenCalledTimes(1)
    expect(requestBodies).toHaveLength(1)
    expect(sha256(requestBodies[0]!)).toHaveLength(64)

    expect(response.stopReason).toBe("tool_use")
    expect(response.stopDetails?.type).toBe("stream_closed_without_terminal")
    expect(response.blocks).toEqual([
      {
        type: "tool_use",
        id: "call_complete",
        name: "Bash",
        input: { command: "echo salvaged" },
      },
    ])
    expect(response.blocks.some((b) => b.type === "tool_use" && b.id === "call_partial")).toBe(
      false,
    )
    expect(response.responseId).toBe("resp_incident_1")
  }, 15_000)

  it("empty terminal-less: exactly one short retry then recovers on second response", async () => {
    let n = 0
    const handler = mock((_req: NetworkRequest) => {
      n++
      if (n === 1) return sseFromEvents(emptyTerminalLessEvents())
      return sseFromEvents(cleanEndEvents("recovered"))
    })
    const networkClient = new NetworkClient({
      primary: { id: "fake", request: async (req) => handler(req) },
    })

    const { response } = await drainSend(
      canonicalSendFn({
        auth,
        messages,
        model: "test-model-recovery",
        selectedProviderId: "test-recovery",
        stream: true,
        networkClient,
      }),
    )

    expect(handler).toHaveBeenCalledTimes(2)
    expect(response.text).toBe("recovered")
    expect(response.stopReason).toBe("end_turn")
  }, 15_000)

  it("empty terminal-less thrice then recovers (never-give-up, not failTurn)", async () => {
    // Never-give-up: empty EOF must keep re-POSTing until the provider recovers.
    let n = 0
    const handler = mock((_req: NetworkRequest) => {
      n++
      if (n <= 3) return sseFromEvents(emptyTerminalLessEvents())
      return sseFromEvents(cleanEndEvents("recovered after empty eof"))
    })
    const networkClient = new NetworkClient({
      primary: { id: "fake", request: async (req) => handler(req) },
    })

    const { response } = await drainSend(
      canonicalSendFn({
        auth,
        messages,
        model: "test-model-recovery",
        selectedProviderId: "test-recovery",
        stream: true,
        networkClient,
      }),
    )

    expect(handler).toHaveBeenCalledTimes(4)
    expect(response.text).toBe("recovered after empty eof")
    expect(response.stopReason).toBe("end_turn")
  }, 15_000)

  it("reasoning-only terminal-less: midstream retry recovers (does not failTurn after one shot)", async () => {
    // Session 113921b7 regression: reasoning-only used to hard-fail after one
    // near-zero retry. Never-give-up + midstream floor must allow recovery.
    let n = 0
    const handler = mock((_req: NetworkRequest) => {
      n++
      if (n <= 3) return sseFromEvents(reasoningOnlyTerminalLessEvents())
      return sseFromEvents(cleanEndEvents("recovered after thinking"))
    })
    const networkClient = new NetworkClient({
      primary: { id: "fake", request: async (req) => handler(req) },
    })

    const { response } = await drainSend(
      canonicalSendFn({
        auth,
        messages,
        model: "test-model-recovery",
        selectedProviderId: "test-recovery",
        stream: true,
        networkClient,
      }),
    )

    expect(handler).toHaveBeenCalledTimes(4)
    expect(response.text).toBe("recovered after thinking")
    expect(response.stopReason).toBe("end_turn")
  }, 30_000)

  it("reasoning-only terminal-less: midstream delay is polite (not 0ms thrash, not slow 30s base)", async () => {
    // Measure the first few midstream sleeps: floor ≥ 1s, not the rate-limit 30s base.
    let n = 0
    const times: number[] = []
    const handler = mock((_req: NetworkRequest) => {
      times.push(Date.now())
      n++
      if (n <= 2) return sseFromEvents(reasoningOnlyTerminalLessEvents())
      return sseFromEvents(cleanEndEvents("ok"))
    })
    const networkClient = new NetworkClient({
      primary: { id: "fake", request: async (req) => handler(req) },
    })

    await drainSend(
      canonicalSendFn({
        auth,
        messages,
        model: "test-model-recovery",
        selectedProviderId: "test-recovery",
        stream: true,
        networkClient,
      }),
    )

    expect(handler).toHaveBeenCalledTimes(3)
    // Gap between attempt 1 and 2 is the midstream floor (~1s with Math.random=0).
    const gap = times[1]! - times[0]!
    expect(gap).toBeGreaterThanOrEqual(900)
    expect(gap).toBeLessThan(10_000)
  }, 20_000)

  it("text-only terminal-less: returns partial text without transport re-POST", async () => {
    const handler = mock((_req: NetworkRequest) =>
      sseFromEvents(textOnlyTerminalLessEvents("Continuing: writing the plan")),
    )
    const networkClient = new NetworkClient({
      primary: { id: "fake", request: async (req) => handler(req) },
    })

    const { response } = await drainSend(
      canonicalSendFn({
        auth,
        messages,
        model: "test-model-recovery",
        selectedProviderId: "test-recovery",
        stream: true,
        networkClient,
      }),
    )

    // Bridge salvages partial text — withRetry never re-enters makeAttempt.
    expect(handler).toHaveBeenCalledTimes(1)
    expect(response.stopReason).toBe("end_turn")
    expect(response.stopDetails?.type).toBe("stream_closed_without_terminal")
    expect(response.text).toBe("Continuing: writing the plan")
    expect(response.blocks.some((b) => b.type === "tool_use")).toBe(false)
  }, 15_000)

  it("stress: 20 sequential complete-tool terminal-less sends never double-POST", async () => {
    const handler = mock((_req: NetworkRequest) => sseFromEvents(incidentTerminalLessEvents()))
    const networkClient = new NetworkClient({
      primary: { id: "fake", request: async (req) => handler(req) },
    })

    for (let i = 0; i < 20; i++) {
      const { response } = await drainSend(
        canonicalSendFn({
          auth,
          messages,
          model: "test-model-recovery",
          selectedProviderId: "test-recovery",
          stream: true,
          networkClient,
        }),
      )
      expect(response.blocks).toHaveLength(1)
      expect(response.blocks[0]).toMatchObject({ id: "call_complete", type: "tool_use" })
    }

    // Exactly one wire request per send — never a post-tool replay.
    expect(handler).toHaveBeenCalledTimes(20)
  }, 30_000)

  it("agent loop: executes complete tool once, continues with different body, never partial", async () => {
    let wireN = 0
    const handler = mock((_req: NetworkRequest) => {
      wireN++
      if (wireN === 1) return sseFromEvents(incidentTerminalLessEvents())
      // Continuation after tool_result — clean finish.
      return sseFromEvents(cleanEndEvents("done after salvage"))
    })
    const networkClient = new NetworkClient({
      primary: { id: "fake", request: async (req) => handler(req) },
    })

    // Capture the *logical* request the agent builds (message history). The
    // synthetic test provider only POSTs `{model,stream}` on the wire, so wire
    // body SHA is NOT a useful divergence signal here — conversation state is.
    const logicalBodies: string[] = []
    const notices: TurnNotice[] = []
    const sendFn = (opts: Parameters<typeof canonicalSendFn>[0]) => {
      logicalBodies.push(JSON.stringify(opts.messages))
      return canonicalSendFn({
        ...opts,
        model: "test-model-recovery",
        selectedProviderId: "test-recovery",
        networkClient,
      })
    }

    const agent = new Agent({
      auth,
      model: "test-model-recovery",
      sendFn: sendFn as never,
    })

    const transcript: string[] = []
    const gen = agent.run("salvage me", {
      onTranscriptLine: (l) => transcript.push(l),
      onNotice: (n) => {
        notices.push(n)
      },
    })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // Wire: interrupted stream once, then continuation once (no post-tool replay
    // of the first stream as a third identical POST).
    expect(handler).toHaveBeenCalledTimes(2)
    expect(logicalBodies).toHaveLength(2)
    // Second agent send must carry tool_result state — not a byte-identical
    // replay of the pre-tool conversation.
    expect(sha256(logicalBodies[0]!)).not.toBe(sha256(logicalBodies[1]!))
    expect(logicalBodies[1]).toContain("call_complete")
    expect(logicalBodies[1]).toContain("tool_result")
    expect(logicalBodies[1]).toContain("stream-interrupted")
    expect(logicalBodies[1]).not.toContain("call_partial")
    // First send has only the user prompt — no tool_result yet.
    expect(logicalBodies[0]).not.toContain("tool_result")

    const history = JSON.stringify(agent.messages)
    expect(history).toContain("call_complete")
    expect(history).toContain("tool_result")
    expect(history).not.toContain("call_partial")
    expect((history.match(/"type":"tool_use"/g) ?? []).length).toBe(1)
    expect((history.match(/"type":"tool_result"/g) ?? []).length).toBe(1)

    expect(notices.some((n) => n.kind === "stream_interrupted_salvaged")).toBe(true)
    // Final assistant text may not always hit onTranscriptLine the same way as
    // tool chrome; assert it landed in conversation history instead.
    expect(history).toContain("done after salvage")
    // Tool chrome still rendered for the salvaged Bash call.
    expect(transcript.join("\n")).toContain("echo salvaged")
  }, 30_000)
})

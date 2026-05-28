/**
 * Transport-contract characterization for the legacy Messages client.
 *
 * Why this file exists
 * ====================
 *
 * This is the **migration baseline** for Phase 4-extended (routing the
 * agent loop through the canonical `src/llm/run()` so non-Anthropic
 * models actually dispatch). Before swapping the transport behind the
 * `Agent.sendFn` seam, we pin the EXACT observable behavior of the
 * current `sendMessage` so the canonical replacement can be proven
 * byte-for-byte equivalent:
 *
 *   1. Hard-timeout watchdog (`attempt_too_long`) — the one watchdog
 *      branch with NO prior coverage. Idle (`stream_idle`) and
 *      close-without-terminator (`stream_truncated`) are pinned in
 *      `client.stream-watchdog.test.ts`; the elapsed-time branch was
 *      not. We pin it here.
 *
 *   2. The observable transport contract: for a representative
 *      thinking → text → tool_use response, exactly which strings get
 *      YIELDED to the text channel, the order the lifecycle callbacks
 *      (`onThinkingStart` / `onThinkingDelta` / `onThinkingStop` /
 *      `onTextStop`) fire in, and the final `StreamedResponse`
 *      (`blocks` / `text` / `stopReason`). Any provider-neutral
 *      transport that wants to sit behind `Agent.sendFn` MUST reproduce
 *      this surface.
 *
 * Like `client.stream-watchdog.test.ts`, these use the in-memory
 * fake-NetworkClient pattern. The actual undici / http2 transports are
 * covered in `src/network/`; the real-wire net-dbg snapshot diff is
 * Phase 4. Here we characterize the parsing + yield + callback layer.
 *
 * @module client.transport-contract.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "./auth.ts"
import { type Message, sendMessage, sendMessageFull } from "./client.ts"
import { getDiagnosticBus, type LogEvent, resetDiagnosticBus } from "./diagnostic-bus.ts"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "./network/index.ts"

// ---------------------------------------------------------------------------
// Helpers (mirrors client.stream-watchdog.test.ts)
// ---------------------------------------------------------------------------

type FakeHandler = (req: NetworkRequest) => NetworkResponse | Promise<NetworkResponse>

function fakeNetworkClient(handler: FakeHandler): NetworkClient {
  const transport: NetworkTransport = {
    id: "fake",
    request: async (req) => handler(req),
  }
  return new NetworkClient({ primary: transport })
}

/** SSE response with an explicit event list (no auto-injected terminator). */
function rawSseResponse(events: unknown[]): NetworkResponse {
  const encoder = new TextEncoder()
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_contract_001" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`))
        }
        controller.close()
      },
    }),
  })
}

/**
 * SSE response that emits some events then leaves the body OPEN forever
 * (no further events, no close). Wires the request signal → close so the
 * watchdog's abort tears the body down the way real transports do.
 */
function stallSseResponse(eventsBeforeStall: unknown[], signal?: AbortSignal): NetworkResponse {
  const encoder = new TextEncoder()
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_contract_stall" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of eventsBeforeStall) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`))
        }
        if (signal) {
          const onAbort = () => {
            try {
              controller.close()
            } catch {
              // already closed — fine
            }
          }
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        }
      },
    }),
  })
}

const auth: AuthResult = { type: "oauth", token: "test-token" }
const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

function collectDiag(): { events: LogEvent[]; dispose: () => void } {
  const events: LogEvent[] = []
  const dispose = getDiagnosticBus().on("*", (e) => {
    events.push(e)
  })
  return { events, dispose }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("client transport contract (canonical-migration baseline)", () => {
  beforeEach(() => resetDiagnosticBus())
  afterEach(() => resetDiagnosticBus())

  // -------------------------------------------------------------------------
  // 1. Hard-timeout watchdog (attempt_too_long) — coverage gap fill.
  // -------------------------------------------------------------------------
  it("hard-timeout: aborts with attempt_too_long, then retries and recovers", async () => {
    // First attempt: a stream that opens, sends ONE event, then stalls
    // open. With a high idle timeout and a tiny hard timeout, the idle
    // branch never fires; the elapsed-time branch trips on the ~1s tick.
    let calls = 0
    const networkClient = fakeNetworkClient((req) => {
      calls++
      if (calls === 1) {
        return stallSseResponse(
          [{ type: "message_start", message: { id: "msg_h", usage: { input_tokens: 1 } } }],
          req.signal,
        )
      }
      return rawSseResponse([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ])
    })

    const { events: diagEvents, dispose } = collectDiag()
    try {
      const result = await sendMessageFull({
        auth,
        messages,
        model: "claude-opus-4-7",
        stream: true,
        networkClient,
        streamIdleTimeoutMs: 30_000, // high → idle branch must NOT fire
        attemptHardTimeoutMs: 50, // tiny → hard-timeout branch fires on first tick
      })
      expect(result.blocks).toEqual([{ type: "text", text: "recovered" }])
    } finally {
      dispose()
    }

    // The stall was classified as attempt_too_long (not stream_idle).
    const stalled = diagEvents.find((e) => e.source === "api.stream-stalled")
    expect(stalled).toBeDefined()
    expect(stalled?.structuredData?.["error-type"]).toBe("attempt_too_long")

    // attempt_too_long is retryable → fast-curve retry on attempt 2.
    const retry = diagEvents.find((e) => e.source === "api.retry")
    expect(retry?.structuredData?.["error-type"]).toBe("attempt_too_long")
    expect(retry?.structuredData?.attempt).toBe(2)
    expect(retry?.structuredData?.curve).toBe("fast")

    const success = diagEvents.find((e) => e.source === "api.retry-success")
    expect(success?.structuredData?.retries).toBe(1)
  }, 30_000)

  // -------------------------------------------------------------------------
  // 2. Observable contract: thinking → text → tool_use.
  //    The exact surface a canonical transport must reproduce behind
  //    Agent.sendFn.
  // -------------------------------------------------------------------------
  it("pins yields + callback order + StreamedResponse for thinking→text→tool_use", async () => {
    const networkClient = fakeNetworkClient(() =>
      rawSseResponse([
        { type: "message_start", message: { id: "msg_c", usage: { input_tokens: 5 } } },
        // --- thinking block (index 0) ---
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
        // --- text block (index 1) ---
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world" } },
        { type: "content_block_stop", index: 1 },
        // --- tool_use block (index 2) ---
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

    // Record the ordered side-effects: text yields and lifecycle callbacks.
    const log: string[] = []
    const yields: string[] = []

    const gen = sendMessage({
      auth,
      messages,
      model: "claude-opus-4-7",
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

    let res: IteratorResult<string, Awaited<ReturnType<typeof sendMessageFull>>>
    while (!(res = await gen.next()).done) {
      yields.push(res.value)
      log.push(`yield:${res.value}`)
    }
    const response = res.value

    // (a) The text channel yields TEXT ONLY — thinking never leaks here.
    expect(yields.join("")).toBe("Hello world")

    // (b) Callback + yield ordering: thinking lifecycle fully precedes the
    //     text yields, onTextStop fires after the text block closes, and
    //     the tool_use block produces no text-channel or callback noise.
    expect(log).toEqual([
      "thinkingStart",
      "thinkingDelta:let me think ",
      "thinkingDelta:about it",
      "thinkingStop",
      "yield:Hello ",
      "yield:world",
      "textStop",
    ])

    // (c) StreamedResponse: structured blocks in stream order, concatenated
    //     text accessor (text blocks only), and the tool_use stop reason.
    expect(response.stopReason).toBe("tool_use")
    expect(response.text).toBe("Hello world")
    expect(response.blocks).toEqual([
      { type: "thinking", thinking: "let me think about it", signature: "sig-xyz" },
      { type: "text", text: "Hello world" },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
    ])
  }, 15_000)
})

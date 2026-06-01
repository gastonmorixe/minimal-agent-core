/**
 * Regression coverage for the `max_tokens` mid-block truncation salvage in
 * `sendMessage*` (legacy Anthropic transport, `src/client.ts`).
 *
 * The bug (observed 2026-05-31, session 772d06b8): when a response hits the
 * `max_tokens` output ceiling while a `tool_use` block is still streaming,
 * the server sends `message_stop` WITHOUT the matching
 * `content_block_stop` for the in-flight block. The parser only pushed a
 * block onto `response.blocks` on `content_block_stop`, so the truncated
 * tool_use was dropped. The agent loop then saw zero tool calls and treated
 * the budget-capped turn as a clean `end_turn` — the turn died silently with
 * an unexecuted command, and the user had to manually re-prompt ("go").
 *
 * The fix finalizes any block left open at stream end exactly as
 * `content_block_stop` would. These asserts pin the contract:
 *
 *   1. A tool_use truncated mid-stream (no content_block_stop) whose JSON
 *      finished streaming is salvaged with parsed `input`.
 *   2. A tool_use whose JSON is incomplete keeps the raw fragment under
 *      `_raw` (so nothing is silently lost; the loop can still see it).
 *   3. `stopReason` is reported as "max_tokens" so the agent loop can act.
 *   4. A truncated text block is salvaged too (no tool_use special-casing).
 *   5. A normally-closed stream is unaffected (no double-push).
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "./auth.ts"
import type { ToolUseBlock } from "./client/types.ts"
import { type Message, sendMessageFull } from "./client.ts"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "./network/index.ts"

type FakeHandler = (req: NetworkRequest) => NetworkResponse | Promise<NetworkResponse>

function fakeNetworkClient(handler: FakeHandler): NetworkClient {
  const transport: NetworkTransport = {
    id: "fake",
    request: async (req) => handler(req),
  }
  return new NetworkClient({ primary: transport })
}

/**
 * Build an SSE NetworkResponse from raw events. Unlike the helper in
 * client.text-stop.test.ts this does NOT auto-append message_stop — the
 * truncation fixtures here control the exact terminator sequence (a
 * max_tokens stream DOES send message_stop, just no content_block_stop for
 * the open block).
 */
function rawSseResponse(events: unknown[]): NetworkResponse {
  const encoder = new TextEncoder()
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`))
        }
        controller.enqueue(encoder.encode("data: [DONE]\n"))
        controller.close()
      },
    }),
  })
}

const auth: AuthResult = { type: "oauth", token: "test-token" }
const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

describe("client max_tokens mid-block salvage", () => {
  it("salvages a tool_use truncated at max_tokens (JSON complete, no content_block_stop)", async () => {
    const networkClient = fakeNetworkClient(() =>
      rawSseResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_1", name: "Bash", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":"mkdir -p out"}' },
        },
        // NOTE: no content_block_stop — the server truncated here.
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens", stop_sequence: null },
          usage: { output_tokens: 64000 },
        },
        { type: "message_stop" },
      ]),
    )

    const result = await sendMessageFull({
      auth,
      messages,
      model: "claude-opus-4-8",
      stream: true,
      networkClient,
    })

    expect(result.stopReason).toBe("max_tokens")
    expect(result.blocks).toHaveLength(1)
    const block = result.blocks[0] as ToolUseBlock
    expect(block.type).toBe("tool_use")
    expect(block.name).toBe("Bash")
    expect(block.id).toBe("tu_1")
    expect(block.input).toEqual({ command: "mkdir -p out" })
  })

  it("keeps the raw fragment when the truncated tool JSON is incomplete", async () => {
    const networkClient = fakeNetworkClient(() =>
      rawSseResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_2", name: "Write", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          // Truncated mid-JSON: not parseable.
          delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/a","content":"hel' },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens", stop_sequence: null },
        },
        { type: "message_stop" },
      ]),
    )

    const result = await sendMessageFull({
      auth,
      messages,
      model: "claude-opus-4-8",
      stream: true,
      networkClient,
    })

    expect(result.stopReason).toBe("max_tokens")
    expect(result.blocks).toHaveLength(1)
    const block = result.blocks[0] as ToolUseBlock
    expect(block.type).toBe("tool_use")
    expect(block.input).toEqual({ _raw: '{"file_path":"/tmp/a","content":"hel' })
  })

  it("salvages a truncated text block (no tool_use special-casing)", async () => {
    const networkClient = fakeNetworkClient(() =>
      rawSseResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial answer that ran out of" },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens", stop_sequence: null },
        },
        { type: "message_stop" },
      ]),
    )

    const result = await sendMessageFull({
      auth,
      messages,
      model: "claude-opus-4-8",
      stream: true,
      networkClient,
    })

    expect(result.stopReason).toBe("max_tokens")
    expect(result.blocks).toEqual([{ type: "text", text: "partial answer that ran out of" }])
  })

  it("drops a thinking block truncated before its signature (would 400 on continuation)", async () => {
    const networkClient = fakeNetworkClient(() =>
      rawSseResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "long reasoning that never got signed" },
        },
        // No signature_delta, no content_block_stop — truncated mid-thinking.
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens", stop_sequence: null },
        },
        { type: "message_stop" },
      ]),
    )

    const result = await sendMessageFull({
      auth,
      messages,
      model: "claude-opus-4-8",
      stream: true,
      networkClient,
    })

    expect(result.stopReason).toBe("max_tokens")
    // Unsigned thinking is dropped so the continuation request stays valid.
    expect(result.blocks).toEqual([])
  })

  it("does not double-push when the stream closes the block normally", async () => {
    const networkClient = fakeNetworkClient(() =>
      rawSseResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_3", name: "Bash", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null } },
        { type: "message_stop" },
      ]),
    )

    const result = await sendMessageFull({
      auth,
      messages,
      model: "claude-opus-4-8",
      stream: true,
      networkClient,
    })

    expect(result.stopReason).toBe("tool_use")
    expect(result.blocks).toHaveLength(1)
    const block = result.blocks[0] as ToolUseBlock
    expect(block.input).toEqual({ command: "ls" })
  })
})

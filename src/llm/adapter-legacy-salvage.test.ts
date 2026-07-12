import { describe, expect, it } from "bun:test"

import { canonicalEventsToLegacyStream } from "./adapter-legacy.ts"
import type { CanonicalEvent } from "./canonical-events.ts"

// Parity coverage for the `max_tokens` mid-block salvage in the canonical
// transport bridge (`canonicalEventsToLegacyStream`). Mirrors the legacy
// client.ts fix: when the stream ends with a block still open (no closing
// `*_stop` event — what a `max_tokens` truncation looks like), the dangling
// block was dropped at loop exit. The agent loop then saw zero tool calls and
// mistook a budget-capped turn for a clean finish. We now finalize the open
// block before returning. This bridge is the single assembly point for BOTH
// canonical providers (OpenAI + Anthropic-via-canonical), so this fix covers
// them all.

async function* fromArray(events: CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  for (const e of events) yield e
}

async function drain(events: CanonicalEvent[]) {
  const gen = canonicalEventsToLegacyStream(fromArray(events))
  let next = await gen.next()
  while (!next.done) next = await gen.next()
  return next.value
}

describe("canonicalEventsToLegacyStream max_tokens salvage", () => {
  it("salvages a tool_use left open at stream end (no tool_use_stop)", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "m1",
        modelId: "test-model-large",
        initialUsage: { inputTokens: 10, outputTokens: 0 },
      },
      { type: "tool_use_start", index: 0, id: "tu_1", name: "Bash" },
      { type: "tool_use_input_delta", index: 0, partialJson: '{"command":"mkdir -p out"}' },
      // No tool_use_stop — truncated by max_tokens.
      {
        type: "message_delta",
        stopReason: "max_tokens",
        usage: { inputTokens: 10, outputTokens: 64000 },
      },
      { type: "message_stop" },
    ])

    expect(response.stopReason).toBe("max_tokens")
    expect(response.blocks).toEqual([
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "mkdir -p out" } },
    ])
  })

  it("salvages an open tool_use whose JSON is incomplete (empty input, nothing lost from blocks[])", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "m2",
        modelId: "test-model-large",
        initialUsage: { inputTokens: 10, outputTokens: 0 },
      },
      { type: "tool_use_start", index: 0, id: "tu_2", name: "Write" },
      {
        type: "tool_use_input_delta",
        index: 0,
        partialJson: '{"file_path":"/tmp/a","content":"hel',
      },
      {
        type: "message_delta",
        stopReason: "max_tokens",
        usage: { inputTokens: 10, outputTokens: 64000 },
      },
      { type: "message_stop" },
    ])

    expect(response.stopReason).toBe("max_tokens")
    // safeParseToolInput returns {} on unparseable JSON, but the block still
    // exists so the loop knows a (broken) tool call was attempted.
    expect(response.blocks).toEqual([{ type: "tool_use", id: "tu_2", name: "Write", input: {} }])
  })

  it("salvages a truncated text block", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "m3",
        modelId: "test-model-large",
        initialUsage: { inputTokens: 10, outputTokens: 0 },
      },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "partial answer" },
      {
        type: "message_delta",
        stopReason: "max_tokens",
        usage: { inputTokens: 10, outputTokens: 64000 },
      },
      { type: "message_stop" },
    ])

    expect(response.stopReason).toBe("max_tokens")
    expect(response.blocks).toEqual([{ type: "text", text: "partial answer" }])
  })

  it("drops a thinking block truncated before its signature", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "m5",
        modelId: "test-model-large",
        initialUsage: { inputTokens: 10, outputTokens: 0 },
      },
      { type: "thinking_start", index: 0 },
      { type: "thinking_delta", index: 0, text: "unsigned reasoning" },
      {
        type: "message_delta",
        stopReason: "max_tokens",
        usage: { inputTokens: 10, outputTokens: 64000 },
      },
      { type: "message_stop" },
    ])

    expect(response.stopReason).toBe("max_tokens")
    expect(response.blocks).toEqual([])
  })

  it("salvages a thinking block that DID receive its signature before truncation", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "m6",
        modelId: "test-model-large",
        initialUsage: { inputTokens: 10, outputTokens: 0 },
      },
      { type: "thinking_start", index: 0 },
      { type: "thinking_delta", index: 0, text: "signed reasoning" },
      { type: "thinking_signature", index: 0, signature: "sig-z" },
      {
        type: "message_delta",
        stopReason: "max_tokens",
        usage: { inputTokens: 10, outputTokens: 64000 },
      },
      { type: "message_stop" },
    ])

    expect(response.stopReason).toBe("max_tokens")
    expect(response.blocks).toEqual([
      { type: "thinking", thinking: "signed reasoning", signature: "sig-z" },
    ])
  })

  // Cross-provider resume regression. An OpenAI-compatible translator (Ollama)
  // defers its text_stop to the stream's `done` handler, so the order is
  // text_start → text_delta → tool_use_* → text_stop. The bridge's single
  // `cur` slot already flushed the real text on tool_use_start, so the trailing
  // text_stop has no open text block and must NOT manufacture a `{text:""}`
  // block — the Anthropic API rejects empty text blocks on a later resend /
  // resume ("text content blocks must be non-empty").
  it("does not synthesize an empty text block from a deferred text_stop after tool_use", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "m7",
        modelId: "deepseek-v4-pro",
        initialUsage: { inputTokens: 10, outputTokens: 0 },
      },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "Running the command." },
      { type: "tool_use_start", index: 1, id: "call_0", name: "Bash" },
      { type: "tool_use_input_delta", index: 1, partialJson: '{"command":"ls"}' },
      { type: "tool_use_stop", index: 1, input: { command: "ls" } },
      // Deferred text_stop for the already-flushed text block (Ollama pattern).
      { type: "text_stop", index: 0, finalText: "" },
      {
        type: "message_delta",
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 30 },
      },
      { type: "message_stop" },
    ])

    expect(response.stopReason).toBe("tool_use")
    expect(response.blocks).toEqual([
      { type: "text", text: "Running the command." },
      { type: "tool_use", id: "call_0", name: "Bash", input: { command: "ls" } },
    ])
    // No empty text block anywhere.
    expect(
      response.blocks.some((b) => b.type === "text" && (b as { text: string }).text === ""),
    ).toBe(false)
  })

  it("drops an empty text block that closes normally (start → stop, no deltas)", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "m8",
        modelId: "test-model-large",
        initialUsage: { inputTokens: 10, outputTokens: 0 },
      },
      { type: "text_start", index: 0 },
      { type: "text_stop", index: 0, finalText: "" },
      {
        type: "message_delta",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      { type: "message_stop" },
    ])
    expect(response.blocks).toEqual([])
  })

  // Terminal-less EOF after complete tool + partial second tool (Grok incident
  // 523dba62): salvage only the closed tool, discard the partial, return
  // stopReason tool_use so the agent loop continues without replaying the body.
  it("salvages complete tool_use and discards partial on stream_closed_without_terminal", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "resp_termless_1",
        modelId: "grok-test",
        initialUsage: { inputTokens: 10, outputTokens: 0 },
      },
      { type: "thinking_start", index: 0 },
      { type: "thinking_delta", index: 0, text: "long live thinking" },
      { type: "thinking_stop", index: 0 },
      { type: "ping" },
      { type: "tool_use_start", index: 1, id: "call_complete", name: "Task" },
      {
        type: "tool_use_input_delta",
        index: 1,
        partialJson: '{"action":"add_many","titles":["a","b"]}',
      },
      {
        type: "tool_use_stop",
        index: 1,
        input: { action: "add_many", titles: ["a", "b"] },
      },
      { type: "tool_use_start", index: 2, id: "call_partial", name: "Task" },
      { type: "tool_use_input_delta", index: 2, partialJson: '{"action":"st' },
      // Terminal-less EOF — no message_delta / message_stop.
      {
        type: "stream_error",
        retryable: true,
        category: "api",
        upstreamType: "stream_closed_without_terminal",
        cause: new Error("OpenAI Responses stream closed without a terminal event (truncated)"),
      },
    ])

    expect(response.stopReason).toBe("tool_use")
    expect(response.stopDetails?.type).toBe("stream_closed_without_terminal")
    expect(response.blocks).toEqual([
      {
        type: "tool_use",
        id: "call_complete",
        name: "Task",
        input: { action: "add_many", titles: ["a", "b"] },
      },
    ])
    expect(response.blocks.some((b) => b.type === "tool_use" && b.id === "call_partial")).toBe(
      false,
    )
    expect(response.responseId).toBe("resp_termless_1")
  })

  it("throws stream_closed_without_terminal with progress when reasoning-only (no text)", async () => {
    let thrown:
      | (Error & {
          streamErrorType?: string
          attemptProgress?: { completedToolCalls: number; sawReasoning: boolean; sawText: boolean }
        })
      | undefined
    try {
      await drain([
        {
          type: "message_start",
          messageId: "resp_empty",
          modelId: "grok-test",
          initialUsage: { inputTokens: 1, outputTokens: 0 },
        },
        { type: "thinking_start", index: 0 },
        { type: "thinking_delta", index: 0, text: "still thinking" },
        { type: "ping" },
        {
          type: "stream_error",
          retryable: true,
          category: "api",
          upstreamType: "stream_closed_without_terminal",
          cause: new Error("truncated"),
        },
      ])
    } catch (e) {
      thrown = e as typeof thrown
    }
    // Reasoning-only with no flushed text/blocks still throws so withRetry
    // can take its one pre-effect transport retry.
    expect(thrown?.streamErrorType).toBe("stream_closed_without_terminal")
    expect(thrown?.attemptProgress?.completedToolCalls).toBe(0)
    expect(thrown?.attemptProgress?.sawReasoning).toBe(true)
    expect(thrown?.attemptProgress?.sawText).toBe(false)
  })

  it("salvages partial text (no complete tools) as end_turn without throwing", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "resp_text",
        modelId: "grok-test",
        initialUsage: { inputTokens: 10, outputTokens: 0 },
      },
      { type: "thinking_start", index: 0 },
      { type: "thinking_delta", index: 0, text: "plan" },
      { type: "thinking_stop", index: 0 },
      { type: "text_start", index: 1 },
      { type: "text_delta", index: 1, text: "Continuing the plan." },
      {
        type: "stream_error",
        retryable: true,
        category: "api",
        upstreamType: "stream_closed_without_terminal",
        cause: new Error("truncated mid text"),
      },
    ])

    expect(response.stopReason).toBe("end_turn")
    expect(response.stopDetails?.type).toBe("stream_closed_without_terminal")
    expect(response.text).toBe("Continuing the plan.")
    expect(response.blocks.some((b) => b.type === "text")).toBe(true)
    expect(response.blocks.some((b) => b.type === "tool_use")).toBe(false)
  })

  it("salvages text and discards open partial tool on terminal-less close", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "resp_text_partial_tool",
        modelId: "grok-test",
        initialUsage: { inputTokens: 10, outputTokens: 0 },
      },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "About to write the file." },
      { type: "text_stop", index: 0 },
      { type: "tool_use_start", index: 1, id: "call_partial", name: "Write" },
      { type: "tool_use_input_delta", index: 1, partialJson: '{"file_path":"/x' },
      {
        type: "stream_error",
        retryable: true,
        category: "api",
        upstreamType: "stream_closed_without_terminal",
        cause: new Error("truncated mid tool"),
      },
    ])

    expect(response.stopReason).toBe("end_turn")
    expect(response.stopDetails?.type).toBe("stream_closed_without_terminal")
    expect(response.text).toBe("About to write the file.")
    expect(response.blocks).toEqual([{ type: "text", text: "About to write the file." }])
    expect(response.blocks.some((b) => b.type === "tool_use")).toBe(false)
  })

  it("does not double-push when the block closed normally", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "m4",
        modelId: "test-model-large",
        initialUsage: { inputTokens: 10, outputTokens: 0 },
      },
      { type: "tool_use_start", index: 0, id: "tu_4", name: "Bash" },
      { type: "tool_use_input_delta", index: 0, partialJson: '{"command":"ls"}' },
      { type: "tool_use_stop", index: 0, input: { command: "ls" } },
      {
        type: "message_delta",
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 50 },
      },
      { type: "message_stop" },
    ])

    expect(response.stopReason).toBe("tool_use")
    expect(response.blocks).toEqual([
      { type: "tool_use", id: "tu_4", name: "Bash", input: { command: "ls" } },
    ])
  })
})

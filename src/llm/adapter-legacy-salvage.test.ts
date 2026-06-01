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
        modelId: "claude-opus-4-8",
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
        modelId: "claude-opus-4-8",
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
        modelId: "claude-opus-4-8",
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
        modelId: "claude-opus-4-8",
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
        modelId: "claude-opus-4-8",
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

  it("does not double-push when the block closed normally", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "m4",
        modelId: "claude-opus-4-8",
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

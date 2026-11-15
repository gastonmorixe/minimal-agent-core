/**
 * Regression tests for the canonical stream assembler.
 *
 * 1. Usage: the persisted per-response usage keeps thinking tokens, the cache
 *    write TTL split, and server web-search calls (research
 *    2026-11-15-anthropic-token-usage-breakdown: they were parsed, then dropped).
 * 2. Refusal: refusal text reaches the assembled blocks, not only the live view.
 * 3. Late `text_stop.finalText`: a block already flushed is not added twice.
 */
import { afterEach, describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "../canonical-events.ts"
import { resetStreamDeltaAccumulator } from "../transport/stream-delta.ts"

import { assembleStreamedResponse } from "./stream-assembler.ts"

async function* fromArray(events: CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  for (const e of events) yield e
}

async function drain(events: CanonicalEvent[]) {
  const gen = assembleStreamedResponse(fromArray(events))
  const yielded: string[] = []
  let next = await gen.next()
  while (!next.done) {
    yielded.push(next.value)
    next = await gen.next()
  }
  return { response: next.value, yielded }
}

afterEach(() => {
  resetStreamDeltaAccumulator()
})

describe("assembleStreamedResponse usage", () => {
  it("keeps thinking tokens, the cache TTL split, and web-search calls", async () => {
    // Shape of net-dbg capture de3a6a5a attempt 004, plus a 1h write and a search.
    const { response } = await drain([
      {
        type: "message_start",
        messageId: "msg_1",
        modelId: "test-model",
        initialUsage: {
          inputTokens: 2,
          outputTokens: 2,
          cacheReadTokens: 24778,
          cacheCreationTokens: 10023,
          cacheBreakdown: { fiveMinute: 10000, oneHour: 23 },
        },
      },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "ok" },
      { type: "text_stop", index: 0, finalText: "ok" },
      {
        type: "message_delta",
        stopReason: "end_turn",
        usage: {
          inputTokens: 2,
          outputTokens: 753,
          cacheReadTokens: 24778,
          cacheCreationTokens: 10023,
          cacheBreakdown: { fiveMinute: 10000, oneHour: 23 },
          reasoningTokens: 315,
          webSearchRequests: 1,
        },
      },
      { type: "message_stop" },
    ])
    expect(response.usage).toEqual({
      input_tokens: 2,
      output_tokens: 753,
      cache_read_input_tokens: 24778,
      cache_creation_input_tokens: 10023,
      cache_creation: { ephemeral_5m_input_tokens: 10000, ephemeral_1h_input_tokens: 23 },
      output_tokens_details: { thinking_tokens: 315 },
      server_tool_use: { web_search_requests: 1 },
    })
  })

  it("keeps the message_start cache split when message_delta omits it", async () => {
    // Anthropic sends `cache_creation` only on message_start (survey: 0 of 11425 deltas).
    const { response } = await drain([
      {
        type: "message_start",
        messageId: "msg_2",
        modelId: "test-model",
        initialUsage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationTokens: 40,
          cacheBreakdown: { fiveMinute: 40, oneHour: 0 },
        },
      },
      {
        type: "message_delta",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 9, cacheCreationTokens: 40, reasoningTokens: 0 },
      },
      { type: "message_stop" },
    ])
    expect(response.usage?.cache_creation).toEqual({
      ephemeral_5m_input_tokens: 40,
      ephemeral_1h_input_tokens: 0,
    })
    expect(response.usage?.output_tokens_details).toEqual({ thinking_tokens: 0 })
  })
})

describe("assembleStreamedResponse refusal", () => {
  it("persists refusal text as a text block", async () => {
    const { response, yielded } = await drain([
      {
        type: "message_start",
        messageId: "m",
        modelId: "test-model",
        initialUsage: { inputTokens: 1, outputTokens: 0 },
      },
      { type: "refusal_delta", text: "I can't " },
      { type: "refusal_delta", text: "help with that." },
      { type: "message_delta", stopReason: "refusal", usage: { inputTokens: 1, outputTokens: 5 } },
      { type: "message_stop" },
    ])
    expect(yielded.join("")).toBe("I can't help with that.")
    expect(response.text).toBe("I can't help with that.")
    expect(response.blocks).toEqual([{ type: "text", text: "I can't help with that." }])
  })
})

describe("assembleStreamedResponse late text_stop", () => {
  it("does not add a text block twice when a later block start already flushed it", async () => {
    const { response } = await drain([
      {
        type: "message_start",
        messageId: "m",
        modelId: "test-model",
        initialUsage: { inputTokens: 1, outputTokens: 0 },
      },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "Let me check." },
      { type: "tool_use_start", index: 1, id: "call_1", name: "Read" },
      { type: "tool_use_input_delta", index: 1, partialJson: "{}" },
      { type: "tool_use_stop", index: 1 },
      { type: "text_stop", index: 0, finalText: "Let me check." },
      { type: "message_delta", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 5 } },
      { type: "message_stop" },
    ])
    expect(response.blocks).toEqual([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "call_1", name: "Read", input: {} },
    ])
  })

  it("still keeps finalText when no delta arrived for that block", async () => {
    const { response } = await drain([
      {
        type: "message_start",
        messageId: "m",
        modelId: "test-model",
        initialUsage: { inputTokens: 1, outputTokens: 0 },
      },
      { type: "tool_use_start", index: 1, id: "call_1", name: "Read" },
      { type: "tool_use_stop", index: 1 },
      { type: "text_stop", index: 0, finalText: "Summary text" },
      { type: "message_delta", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 5 } },
      { type: "message_stop" },
    ])
    expect(response.blocks).toEqual([
      { type: "tool_use", id: "call_1", name: "Read", input: {} },
      { type: "text", text: "Summary text" },
    ])
  })
})

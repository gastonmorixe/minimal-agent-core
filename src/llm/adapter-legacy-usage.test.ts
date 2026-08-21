import { afterEach, describe, expect, it } from "bun:test"

import { setGlobalEventBus } from "../bus/global-bus.ts"
import { EventBus } from "../plugins/event-bus.ts"

import { canonicalEventsToLegacyStream } from "./adapter-legacy.ts"
import type { CanonicalEvent, CanonicalUsage } from "./canonical-events.ts"
import {
  LLM_OUTPUT_DELTA,
  LLM_OUTPUT_END,
  resetStreamDeltaAccumulator,
} from "./transport/stream-delta.ts"

async function* fromArray(events: CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  for (const e of events) yield e
}

async function drain(events: CanonicalEvent[]) {
  const gen = canonicalEventsToLegacyStream(fromArray(events))
  let next = await gen.next()
  while (!next.done) next = await gen.next()
  return next.value
}

const initialUsage: CanonicalUsage = {
  inputTokens: 1200,
  outputTokens: 0,
  cacheReadTokens: 8000,
  cacheCreationTokens: 500,
}
const finalUsage: CanonicalUsage = {
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 8000,
  cacheCreationTokens: 500,
}

afterEach(() => {
  resetStreamDeltaAccumulator()
  setGlobalEventBus(null)
})

describe("canonicalEventsToLegacyStream output telemetry", () => {
  it("batches deltas through the real bus and emits one end after the final flush", async () => {
    const bus = new EventBus(() => {})
    const seen: Array<{ channel: string; payload: unknown }> = []
    bus.on(LLM_OUTPUT_DELTA, (ctx) => {
      seen.push({ channel: ctx.event, payload: ctx.payload })
    })
    bus.on(LLM_OUTPUT_END, (ctx) => {
      seen.push({ channel: ctx.event, payload: ctx.payload })
    })
    setGlobalEventBus(bus)

    await drain([
      { type: "message_start", messageId: "m1", modelId: "test-model-large", initialUsage },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "x".repeat(200) },
      { type: "text_delta", index: 0, text: "y".repeat(100) },
      { type: "text_stop", index: 0, finalText: "" },
      { type: "message_delta", stopReason: "end_turn", usage: finalUsage },
      { type: "message_stop" },
    ])
    await Promise.resolve()
    await Promise.resolve()

    expect(seen).toEqual([
      { channel: LLM_OUTPUT_DELTA, payload: { deltaTokens: 50 } },
      { channel: LLM_OUTPUT_DELTA, payload: { deltaTokens: 25 } },
      { channel: LLM_OUTPUT_END, payload: { reason: "stream_end" } },
    ])
  })

  it("emits output end after a stream error", async () => {
    const bus = new EventBus(() => {})
    const seen: Array<{ channel: string; payload: unknown }> = []
    bus.on(LLM_OUTPUT_END, (ctx) => {
      seen.push({ channel: ctx.event, payload: ctx.payload })
    })
    setGlobalEventBus(bus)

    await expect(
      drain([
        { type: "message_start", messageId: "m1", modelId: "test-model-large", initialUsage },
        { type: "stream_error", retryable: false, category: "api" },
      ]),
    ).rejects.toThrow("canonical stream error: api")
    await Promise.resolve()
    await Promise.resolve()

    expect(seen).toEqual([{ channel: LLM_OUTPUT_END, payload: { reason: "stream_end" } }])
  })

  it("does not emit output end until a tool-use stream finishes", async () => {
    const bus = new EventBus(() => {})
    const seen: Array<{ channel: string; payload: unknown }> = []
    bus.on(LLM_OUTPUT_END, (ctx) => {
      seen.push({ channel: ctx.event, payload: ctx.payload })
    })
    setGlobalEventBus(bus)

    await drain([
      { type: "message_start", messageId: "m1", modelId: "test-model-large", initialUsage },
      { type: "tool_use_start", index: 0, id: "tool_1", name: "Bash" },
      { type: "tool_use_stop", index: 0 },
      { type: "message_delta", stopReason: "tool_use", usage: finalUsage },
      { type: "message_stop" },
    ])
    await Promise.resolve()
    await Promise.resolve()

    expect(seen).toEqual([{ channel: LLM_OUTPUT_END, payload: { reason: "stream_end" } }])
  })
})

describe("canonicalEventsToLegacyStream usage capture", () => {
  it("surfaces merged usage (incl. final output_tokens) on StreamedResponse.usage", async () => {
    const response = await drain([
      { type: "message_start", messageId: "m1", modelId: "test-model-large", initialUsage },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "hi" },
      { type: "text_stop", index: 0, finalText: "hi" },
      { type: "message_delta", stopReason: "end_turn", usage: finalUsage },
      { type: "message_stop" },
    ])
    expect(response.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 500,
    })
  })

  it("falls back to message_start usage when message_delta omits output", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "m2",
        modelId: "test-model-large",
        initialUsage: { inputTokens: 5, outputTokens: 0 },
      },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "x" },
      { type: "text_stop", index: 0, finalText: "x" },
      {
        type: "message_delta",
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 0 },
      },
      { type: "message_stop" },
    ])
    expect(response.usage).toEqual({ input_tokens: 5, output_tokens: 0 })
  })
})

describe("canonicalEventsToLegacyStream responseId capture", () => {
  it("surfaces the message_start messageId as StreamedResponse.responseId", async () => {
    // Regression guard: the provider response id (e.g. a Responses-style
    // `resp_...` from the OpenAI plugin) used to be read only for
    // status/usage and was silently dropped, so nothing downstream could
    // ever thread it back via previous_response_id. It must now ride the
    // StreamedResponse.
    const response = await drain([
      {
        type: "message_start",
        messageId: "resp_abc123",
        modelId: "test-model-large",
        initialUsage: { inputTokens: 10, outputTokens: 0 },
      },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "ok" },
      { type: "text_stop", index: 0, finalText: "ok" },
      {
        type: "message_delta",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 2 },
      },
      { type: "message_stop" },
    ])
    expect(response.responseId).toBe("resp_abc123")
  })

  it("leaves responseId undefined when no message_start id is present", async () => {
    const response = await drain([
      {
        type: "message_start",
        messageId: "",
        modelId: "test-model-large",
        initialUsage: { inputTokens: 1, outputTokens: 0 },
      },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "x" },
      { type: "text_stop", index: 0, finalText: "x" },
      { type: "message_delta", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "message_stop" },
    ])
    expect(response.responseId).toBeUndefined()
  })
})

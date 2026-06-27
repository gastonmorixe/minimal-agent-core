import { describe, expect, it } from "bun:test"

import { canonicalEventsToLegacyStream } from "./adapter-legacy.ts"
import type { CanonicalEvent, CanonicalUsage } from "./canonical-events.ts"

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

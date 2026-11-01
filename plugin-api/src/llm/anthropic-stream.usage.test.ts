/**
 * Golden Anthropic usage payload to CanonicalUsage. Anthropic `input_tokens`
 * already excludes cache reads and cache writes. Canonical `inputTokens` has
 * the same meaning, so the adapter copies it and `used` is the sum of the
 * three input counters.
 */

import { describe, expect, it } from "bun:test"

import { type AnthropicStreamEvent, translateAnthropicStream } from "./anthropic-stream.ts"
import type { CanonicalUsage } from "./canonical-events.ts"

async function* fromArray(events: AnthropicStreamEvent[]): AsyncIterable<AnthropicStreamEvent> {
  for (const ev of events) yield ev
}

const GOLDEN: AnthropicStreamEvent[] = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      model: "test-model",
      usage: {
        input_tokens: 1000,
        output_tokens: 1,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 50,
      },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } },
  { type: "message_stop" },
]

describe("translateAnthropicStream usage", () => {
  it("maps input 1000 + cache read 200 + cache write 50 to disjoint counters, used 1250", async () => {
    let usage: CanonicalUsage | undefined
    for await (const ev of translateAnthropicStream(fromArray(GOLDEN))) {
      if (ev.type === "message_delta") usage = ev.usage
    }
    expect(usage?.inputTokens).toBe(1000)
    expect(usage?.cacheReadTokens).toBe(200)
    expect(usage?.cacheCreationTokens).toBe(50)
    expect(usage?.outputTokens).toBe(40)
    const used = (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheCreationTokens ?? 0)
    expect(used).toBe(1250)
  })
})

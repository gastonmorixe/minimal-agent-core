import { beforeEach, describe, expect, it } from "bun:test"

import type { PluginEventsPort } from "../../bus/plugin-events-port.ts"

import {
  getStreamDeltaAccumulator,
  LLM_OUTPUT_DELTA,
  resetStreamDeltaAccumulator,
} from "./stream-delta.ts"

/** A `PluginEventsPort` capturing every emitted channel/payload. */
function makeSink(): PluginEventsPort & { events: Array<{ channel: string; payload: unknown }> } {
  const events: Array<{ channel: string; payload: unknown }> = []
  return {
    events,
    emit: (event: string, payload?: unknown) => {
      events.push({ channel: event, payload })
    },
  }
}

beforeEach(() => resetStreamDeltaAccumulator())

describe("stream-delta accumulator", () => {
  it("emits nothing before any add", () => {
    const sink = makeSink()
    getStreamDeltaAccumulator().maybeFlush(sink)
    expect(sink.events).toEqual([])
  })

  it("batches small deltas under BATCH_MS and flushes at stream end", () => {
    const sink = makeSink()
    const acc = getStreamDeltaAccumulator()
    acc.add(100) // ~25 tokens
    acc.maybeFlush(sink) // 25 < 50 tokens AND <250ms → held
    expect(sink.events).toEqual([])
    acc.flush(sink) // stream end → final partial batch lands
    expect(sink.events.length).toBe(1)
    expect(sink.events[0]!.channel).toBe(LLM_OUTPUT_DELTA)
    // 100 chars / 4 = 25 tokens.
    expect(sink.events[0]!.payload).toEqual({ deltaTokens: 25 })
  })

  it("flushes when accumulated tokens reach the batch threshold", async () => {
    const sink = makeSink()
    const acc = getStreamDeltaAccumulator()
    // 4 chars/token × 50-token threshold = 200 chars minimum, but the time
    // check also gates; use a fresh accumulator per emit so >250ms has NOT
    // elapsed — only the token threshold can trigger.
    for (let i = 0; i < 60; i++) {
      acc.add(4) // 1 token each
      acc.maybeFlush(sink)
      await new Promise((r) => setTimeout(r, 0))
    }
    // At least one threshold-triggered flush happened (≥50 tokens).
    const total = sink.events.reduce(
      (sum, e) => sum + (e.payload as { deltaTokens: number }).deltaTokens,
      0,
    )
    expect(total).toBeGreaterThanOrEqual(50)
  }, 5_000)

  it("is a no-op with no sink (spec S28: never reads a global pointer)", () => {
    const acc = getStreamDeltaAccumulator()
    acc.add(400)
    expect(() => acc.maybeFlush()).not.toThrow()
    expect(() => acc.flush()).not.toThrow()
  })

  it("reset drops the active accumulator (fresh state per send)", () => {
    const sink = makeSink()
    getStreamDeltaAccumulator().add(100)
    resetStreamDeltaAccumulator()
    // New accumulator starts empty: nothing held from the previous one.
    getStreamDeltaAccumulator().maybeFlush(sink)
    expect(sink.events).toEqual([])
  })
})

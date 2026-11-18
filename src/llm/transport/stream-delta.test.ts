import { beforeEach, describe, expect, it, spyOn } from "bun:test"

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

  it("flushes when accumulated tokens reach the batch threshold", () => {
    // Hold the clock still, so only the token gate can flush. With the real
    // clock, a slow runner passes BATCH_MS mid-loop: the time gate flushes
    // early and the rest never reaches BATCH_TOKENS (CI run 44207247891).
    const now = spyOn(performance, "now").mockReturnValue(1_000)
    try {
      const sink = makeSink()
      const acc = getStreamDeltaAccumulator()
      for (let i = 0; i < 60; i++) {
        acc.add(4) // 1 token each
        acc.maybeFlush(sink)
      }
      // One flush, at exactly 50 tokens. The other 10 stay pending.
      expect(sink.events.map((e) => e.payload)).toEqual([{ deltaTokens: 50 }])
    } finally {
      now.mockRestore()
    }
  })

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

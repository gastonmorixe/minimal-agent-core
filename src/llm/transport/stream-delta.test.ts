import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { EventBus } from "../../../src/plugins/event-bus.ts"
import { setGlobalEventBus } from "../../bus/global-bus.ts"

import {
  getStreamDeltaAccumulator,
  LLM_OUTPUT_DELTA,
  resetStreamDeltaAccumulator,
} from "./stream-delta.ts"

/** Minimal EventBus stub capturing emitted channels/payloads. */
function makeBus(): EventBus & { events: Array<{ channel: string; payload: unknown }> } {
  const events: Array<{ channel: string; payload: unknown }> = []
  return {
    events,
    on: (() => () => {}) as never,
    off: (() => {}) as never,
    emit: (channel: string, payload?: unknown) => {
      events.push({ channel, payload })
    },
  } as never
}

beforeEach(() => resetStreamDeltaAccumulator())
afterEach(() => setGlobalEventBus(null))

describe("stream-delta accumulator", () => {
  it("emits nothing before any add", () => {
    const bus = makeBus()
    setGlobalEventBus(bus)
    getStreamDeltaAccumulator().maybeFlush()
    expect(bus.events).toEqual([])
  })

  it("batches small deltas under BATCH_MS and flushes at stream end", () => {
    const bus = makeBus()
    setGlobalEventBus(bus)
    const acc = getStreamDeltaAccumulator()
    acc.add(100) // ~25 tokens
    acc.maybeFlush() // 25 < 50 tokens AND <250ms → held
    expect(bus.events).toEqual([])
    acc.flush() // stream end → final partial batch lands
    expect(bus.events.length).toBe(1)
    expect(bus.events[0]!.channel).toBe(LLM_OUTPUT_DELTA)
    // 100 chars / 4 = 25 tokens.
    expect(bus.events[0]!.payload).toEqual({ deltaTokens: 25 })
  })

  it("flushes when accumulated tokens reach the batch threshold", async () => {
    const bus = makeBus()
    setGlobalEventBus(bus)
    const acc = getStreamDeltaAccumulator()
    // 4 chars/token × 50-token threshold = 200 chars minimum, but the time
    // check also gates; use a fresh accumulator per emit so >250ms has NOT
    // elapsed — only the token threshold can trigger.
    for (let i = 0; i < 60; i++) {
      acc.add(4) // 1 token each
      acc.maybeFlush()
      await new Promise((r) => setTimeout(r, 0))
    }
    // At least one threshold-triggered flush happened (≥50 tokens).
    const total = bus.events.reduce(
      (sum, e) => sum + (e.payload as { deltaTokens: number }).deltaTokens,
      0,
    )
    expect(total).toBeGreaterThanOrEqual(50)
  }, 5_000)

  it("is a no-op without a bus (pre-load/test safety)", () => {
    setGlobalEventBus(null)
    const acc = getStreamDeltaAccumulator()
    acc.add(400)
    acc.maybeFlush()
    acc.flush()
    // No throw — emits are optional-chained away.
  })

  it("reset drops the active accumulator (fresh state per send)", () => {
    const bus = makeBus()
    setGlobalEventBus(bus)
    getStreamDeltaAccumulator().add(100)
    resetStreamDeltaAccumulator()
    // New accumulator starts empty: nothing held from the previous one.
    getStreamDeltaAccumulator().maybeFlush()
    expect(bus.events).toEqual([])
  })
})

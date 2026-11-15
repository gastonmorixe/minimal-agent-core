import { describe, expect, it } from "bun:test"

import type { StatusActivity } from "../../bus/status.ts"

import { createBlockStatusPublisher } from "./block-status-publisher.ts"
import type { StreamBlockState } from "./stream-block-tracker.ts"

function setup(throttleMs = 100) {
  let t = 0
  const out: StatusActivity[] = []
  const pub = createBlockStatusPublisher(
    { updateActivity: (a) => out.push({ ...a }) },
    { now: () => t, throttleMs },
  )
  const state = (
    s: Partial<StreamBlockState> & { idleBudgetMs?: number } = {},
  ): StreamBlockState & { idleBudgetMs: number } => ({
    phase: "stream",
    phaseStartedAt: 0,
    toolName: undefined,
    lastContentAt: t,
    idleBudgetMs: 30_000,
    ...s,
  })
  return { out, pub, state, setT: (v: number) => (t = v) }
}

describe("createBlockStatusPublisher", () => {
  it("publishes phase changes at once and throttles content-only moves", () => {
    const { out, pub, state, setT } = setup()
    pub.onBlockState(state(), true)
    setT(10)
    pub.onBlockState(state(), false) // within throttle → dropped
    setT(20)
    pub.onBlockState(state({ phase: "thinking", idleBudgetMs: 300_000 }), true)
    setT(150)
    pub.onBlockState(state({ phase: "thinking", idleBudgetMs: 300_000 }), false) // past throttle
    expect(out.map((a) => [a.phase, a.lastContentAt])).toEqual([
      ["stream", 0],
      ["thinking", 20],
      ["thinking", 150],
    ])
  })

  it("an idle budget change publishes even inside the throttle window", () => {
    const { out, pub, state, setT } = setup()
    pub.onBlockState(state(), true)
    setT(5)
    pub.onBlockState(state({ idleBudgetMs: 300_000 }), false)
    expect(out).toHaveLength(2)
  })

  it("sends toolName null when no tool block is open, so the bus clears it", () => {
    const { out, pub, state } = setup()
    pub.onBlockState(state({ phase: "tool-input", toolName: "Write" }), true)
    pub.onBlockState(state({ phase: "stream" }), true)
    expect(out.map((a) => a.toolName)).toEqual(["Write", null])
  })

  it("attemptStarted resets to connect and drops the previous tool", () => {
    const { out, pub, state, setT } = setup()
    pub.onBlockState(state({ phase: "thinking" }), true)
    setT(42)
    pub.attemptStarted()
    expect(out[out.length - 1]).toEqual({ phase: "connect", phaseStartedAt: 42, toolName: null })
    // The next state is not throttled against the previous attempt.
    pub.onBlockState(state(), false)
    expect(out[out.length - 1]?.phase).toBe("stream")
  })
})

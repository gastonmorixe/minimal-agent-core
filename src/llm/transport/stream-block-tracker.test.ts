import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "../canonical-events.ts"

import { StreamBlockTracker } from "./stream-block-tracker.ts"

const START: CanonicalEvent = {
  type: "message_start",
  messageId: "m",
  modelId: "test-model",
  initialUsage: { inputTokens: 1, outputTokens: 0 },
}

function clock(start = 1_000): { now: () => number; set: (t: number) => void } {
  let t = start
  return { now: () => t, set: (v) => (t = v) }
}

describe("StreamBlockTracker", () => {
  it("starts with no phase, then `stream` on message_start", () => {
    const c = clock()
    const tr = new StreamBlockTracker(c.now)
    expect(tr.snapshot().phase).toBeUndefined()
    expect(tr.observe(START)).toBe(true)
    expect(tr.snapshot()).toEqual({
      phase: "stream",
      phaseStartedAt: 1_000,
      toolName: undefined,
      lastContentAt: 1_000,
    })
  })

  it("tracks thinking → tool-input → stream like the a8f44b2f capture", () => {
    const c = clock()
    const tr = new StreamBlockTracker(c.now)
    tr.observe(START)
    c.set(1_400)
    expect(tr.observe({ type: "thinking_start", index: 0 })).toBe(true)
    expect(tr.snapshot().phase).toBe("thinking")
    expect(tr.isSilentBlockOpen()).toBe(true)

    // 30s of silence broken only by a keep-alive ping: not content.
    c.set(31_400)
    expect(tr.observe({ type: "ping" })).toBe(false)
    expect(tr.snapshot().lastContentAt).toBe(1_400)
    expect(tr.snapshot().phaseStartedAt).toBe(1_400)

    c.set(39_800)
    tr.observe({ type: "thinking_delta", index: 0, text: "" })
    tr.observe({ type: "thinking_signature", index: 0, signature: "sig" })
    expect(tr.snapshot().lastContentAt).toBe(39_800)
    expect(tr.observe({ type: "thinking_stop", index: 0 })).toBe(true)
    expect(tr.snapshot().phase).toBe("stream")
    expect(tr.isSilentBlockOpen()).toBe(false)

    c.set(39_900)
    tr.observe({ type: "tool_use_start", index: 1, id: "t1", name: "Write" })
    expect(tr.snapshot()).toMatchObject({
      phase: "tool-input",
      toolName: "Write",
      phaseStartedAt: 39_900,
    })
    expect(tr.isSilentBlockOpen()).toBe(true)
    expect(tr.observe({ type: "tool_use_input_delta", index: 1, partialJson: "{" })).toBe(false)

    c.set(41_000)
    tr.observe({ type: "tool_use_stop", index: 1 })
    expect(tr.snapshot()).toMatchObject({
      phase: "stream",
      toolName: undefined,
      phaseStartedAt: 41_000,
    })
  })

  it("text blocks are `writing` and not silent-tolerant", () => {
    const tr = new StreamBlockTracker(clock().now)
    tr.observe(START)
    tr.observe({ type: "text_start", index: 0 })
    expect(tr.snapshot().phase).toBe("writing")
    expect(tr.isSilentBlockOpen()).toBe(false)
  })

  it("two tool calls back to back change the tool name", () => {
    const c = clock()
    const tr = new StreamBlockTracker(c.now)
    tr.observe(START)
    tr.observe({ type: "tool_use_start", index: 0, id: "a", name: "Read" })
    tr.observe({ type: "tool_use_stop", index: 0 })
    c.set(2_000)
    expect(tr.observe({ type: "tool_use_start", index: 1, id: "b", name: "Bash" })).toBe(true)
    expect(tr.snapshot()).toMatchObject({
      phase: "tool-input",
      toolName: "Bash",
      phaseStartedAt: 2_000,
    })
  })

  it("interleaved blocks: the newest open block wins, stops by index", () => {
    const tr = new StreamBlockTracker(clock().now)
    tr.observe(START)
    tr.observe({ type: "thinking_start", index: 0 })
    tr.observe({ type: "tool_use_start", index: 1, id: "a", name: "Edit" })
    expect(tr.snapshot().phase).toBe("tool-input")
    tr.observe({ type: "tool_use_stop", index: 1 })
    expect(tr.snapshot().phase).toBe("thinking")
    tr.observe({ type: "thinking_stop", index: 0 })
    expect(tr.snapshot().phase).toBe("stream")
  })

  it("message_stop closes any block left open", () => {
    const tr = new StreamBlockTracker(clock().now)
    tr.observe(START)
    tr.observe({ type: "thinking_start", index: 0 })
    tr.observe({ type: "message_stop" })
    expect(tr.snapshot().phase).toBe("stream")
    expect(tr.isSilentBlockOpen()).toBe(false)
  })

  it("snapshot is a copy", () => {
    const tr = new StreamBlockTracker(clock().now)
    tr.observe(START)
    const s = tr.snapshot()
    s.phase = "thinking"
    expect(tr.snapshot().phase).toBe("stream")
  })
})

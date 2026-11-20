/**
 * Tests for the pre-stream stall count (each retry doubles the budget).
 *
 * @module llm/transport/pre-stream-streak.test
 */

import { describe, expect, it } from "bun:test"

import {
  MAX_PRE_STREAM_STREAKS,
  PRE_STREAM_STREAK_TTL_MS,
  PreStreamStreaks,
  preStreamStreakKey,
} from "./pre-stream-streak.ts"

describe("PreStreamStreaks", () => {
  it("counts stalls for each key and clears on an answer", () => {
    const s = new PreStreamStreaks()
    const a = preStreamStreakKey("s1", "p", "m")
    const b = preStreamStreakKey("s2", "p", "m")
    expect(s.get(a)).toBe(0)
    s.stalled(a)
    s.stalled(a)
    s.stalled(b)
    expect(s.get(a)).toBe(2)
    expect(s.get(b)).toBe(1)
    s.clear(a)
    expect(s.get(a)).toBe(0)
    expect(s.get(b)).toBe(1)
  })

  it("forgets a stale streak", () => {
    const s = new PreStreamStreaks()
    s.stalled("k", 1000)
    expect(s.get("k", 1000 + PRE_STREAM_STREAK_TTL_MS)).toBe(1)
    expect(s.get("k", 1001 + PRE_STREAM_STREAK_TTL_MS)).toBe(0)
    // A stall after a stale entry starts again at 1.
    s.stalled("k", 1000)
    s.stalled("k", 2002 + PRE_STREAM_STREAK_TTL_MS)
    expect(s.get("k", 2002 + PRE_STREAM_STREAK_TTL_MS)).toBe(1)
  })

  it("keeps at most MAX_PRE_STREAM_STREAKS entries (the oldest goes out)", () => {
    const s = new PreStreamStreaks()
    for (let i = 0; i <= MAX_PRE_STREAM_STREAKS; i++) s.stalled(`k${i}`)
    expect(s.get("k0")).toBe(0)
    expect(s.get("k1")).toBe(1)
    expect(s.get(`k${MAX_PRE_STREAM_STREAKS}`)).toBe(1)
  })
})

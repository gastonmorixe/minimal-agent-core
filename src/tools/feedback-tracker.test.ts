/**
 * Tests for {@link ToolFeedbackTracker} — the streak-detection nudge layer.
 *
 * Behavior under test:
 *  - 3 consecutive truncations on the same tool → emit a `[note: ...]`.
 *  - A non-truncated call breaks the streak (counter resets to 0).
 *  - Per-tool counters are independent.
 *  - Once a streak fires, the counter resets — model gets one nudge, not N.
 *  - Custom thresholds work (so tests don't need to repeat 3 calls).
 *  - Note bodies are tool-aware (Read mentions offset/limit, Bash mentions
 *    head/tail, etc.).
 */
import { describe, expect, it } from "bun:test"

import { DEFAULT_STREAK_THRESHOLD, ToolFeedbackTracker } from "./feedback-tracker.ts"

describe("ToolFeedbackTracker — basic streak detection", () => {
  it("emits null on the first truncation (below threshold)", () => {
    const t = new ToolFeedbackTracker()
    expect(t.observe("Read", true)).toBeNull()
    expect(t.streakOf("Read")).toBe(1)
  })

  it("emits null on the second truncation (still below threshold)", () => {
    const t = new ToolFeedbackTracker()
    t.observe("Read", true)
    expect(t.observe("Read", true)).toBeNull()
    expect(t.streakOf("Read")).toBe(2)
  })

  it("emits a `[note: ...]` on the threshold-th consecutive truncation", () => {
    const t = new ToolFeedbackTracker()
    t.observe("Read", true)
    t.observe("Read", true)
    const note = t.observe("Read", true)
    expect(note).not.toBeNull()
    expect(note).toMatch(/^\[note: /)
    expect(note).toMatch(/\]$/)
    expect(note).toContain("Read")
  })

  it("default threshold is 3 (matches DEFAULT_STREAK_THRESHOLD)", () => {
    expect(DEFAULT_STREAK_THRESHOLD).toBe(3)
  })
})

describe("ToolFeedbackTracker — reset semantics", () => {
  it("a non-truncated call resets the streak", () => {
    const t = new ToolFeedbackTracker()
    t.observe("Read", true)
    t.observe("Read", true)
    t.observe("Read", false) // resets
    expect(t.streakOf("Read")).toBe(0)
    expect(t.observe("Read", true)).toBeNull() // back to 1 / 3
    expect(t.streakOf("Read")).toBe(1)
  })

  it("firing the note resets the counter (no nag spam)", () => {
    const t = new ToolFeedbackTracker()
    t.observe("Read", true)
    t.observe("Read", true)
    expect(t.observe("Read", true)).not.toBeNull() // fires
    expect(t.streakOf("Read")).toBe(0)
    // Next truncation does NOT immediately re-fire — counter starts over.
    expect(t.observe("Read", true)).toBeNull()
    expect(t.observe("Read", true)).toBeNull()
    expect(t.observe("Read", true)).not.toBeNull() // fires again after 3 more
  })

  it("explicit reset() clears all counters", () => {
    const t = new ToolFeedbackTracker()
    t.observe("Read", true)
    t.observe("Bash", true)
    t.reset()
    expect(t.streakOf("Read")).toBe(0)
    expect(t.streakOf("Bash")).toBe(0)
  })
})

describe("ToolFeedbackTracker — per-tool independence", () => {
  it("Read truncations do NOT reset the Bash streak", () => {
    const t = new ToolFeedbackTracker()
    t.observe("Bash", true)
    t.observe("Bash", true)
    // Interleave a Read call — should not affect Bash.
    t.observe("Read", true)
    expect(t.streakOf("Bash")).toBe(2)
    expect(t.streakOf("Read")).toBe(1)
    // Bash hits threshold next.
    expect(t.observe("Bash", true)).not.toBeNull()
  })

  it("a non-truncated Read call does NOT reset the Bash streak", () => {
    const t = new ToolFeedbackTracker()
    t.observe("Bash", true)
    t.observe("Bash", true)
    t.observe("Read", false) // Read success — Bash unaffected
    expect(t.streakOf("Bash")).toBe(2)
    expect(t.observe("Bash", true)).not.toBeNull()
  })

  it("each tool fires its own threshold independently", () => {
    const t = new ToolFeedbackTracker()
    for (let i = 0; i < 3; i++) {
      const note = t.observe("Read", true)
      if (i < 2) expect(note).toBeNull()
      else {
        expect(note).not.toBeNull()
        expect(note).toContain("Read")
      }
    }
    for (let i = 0; i < 3; i++) {
      const note = t.observe("Bash", true)
      if (i < 2) expect(note).toBeNull()
      else {
        expect(note).not.toBeNull()
        expect(note).toContain("Bash")
      }
    }
  })
})

describe("ToolFeedbackTracker — note content is tool-aware", () => {
  function fireFor(tool: string): string {
    const t = new ToolFeedbackTracker()
    t.observe(tool, true)
    t.observe(tool, true)
    const note = t.observe(tool, true)
    if (note === null) throw new Error("expected note to fire")
    return note
  }

  it("Read note mentions offset / limit / paging", () => {
    const note = fireFor("Read")
    expect(note).toMatch(/offset/i)
  })

  it("Grep note mentions narrowing strategies", () => {
    const note = fireFor("Grep")
    expect(note).toMatch(/files_with_matches|head_limit|glob/i)
  })

  it("Bash note mentions output-bounding", () => {
    const note = fireFor("Bash")
    expect(note).toMatch(/head|tail|sed/i)
  })

  it("Glob note mentions narrowing", () => {
    const note = fireFor("Glob")
    expect(note).toMatch(/narrow|extension|subdirectory/i)
  })

  it("unknown tool falls back to a generic note", () => {
    // Generic note doesn't include the tool name (no tool-specific prose
    // available); it just references the [truncated: ...] notices and
    // tells the model to re-think parameters.
    const note = fireFor("Mystery")
    expect(note).toMatch(/re-think|parameters|truncated/i)
    // Still wrapped in the standard `[note: ...]` envelope.
    expect(note).toMatch(/^\[note: /)
  })
})

describe("ToolFeedbackTracker — threshold parameter", () => {
  it("custom threshold of 2 fires at the second truncation", () => {
    const t = new ToolFeedbackTracker(2)
    expect(t.observe("Read", true)).toBeNull()
    expect(t.observe("Read", true)).not.toBeNull()
  })

  it("custom threshold of 1 fires immediately", () => {
    const t = new ToolFeedbackTracker(1)
    const note = t.observe("Read", true)
    expect(note).not.toBeNull()
    expect(t.streakOf("Read")).toBe(0) // reset after firing
  })
})

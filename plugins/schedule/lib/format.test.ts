/**
 * Tests for the pure (model-facing) schedule formatters. These must stay
 * ANSI-free and emoji-free: their output can land in tool-result `content`,
 * which the model reads. Color lives in ./footer.ts (see footer.test.ts).
 */

import { describe, expect, it } from "bun:test"

import {
  cadenceLabel,
  clipPrompt,
  describeCreated,
  formatEntry,
  formatList,
  kindGlyph,
  relativeTime,
} from "./format.ts"
import type { CronEntry } from "./store.ts"

const NOW = 1_700_000_000_000

function mk(over: Partial<CronEntry> = {}): CronEntry {
  return {
    id: "abcd1234",
    cron: "*/5 * * * *",
    prompt: "check the deploy",
    recurs: true,
    pace: "fixed",
    createdAt: 0,
    ...over,
  }
}

// No surface here may carry a color-emoji or an ANSI escape.
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting ANSI is the point.
const ANSI = /\x1b\[/
function assertCleanText(s: string): void {
  expect(s).not.toContain("⏰") // the old color-emoji
  expect(ANSI.test(s)).toBe(false)
}

describe("kindGlyph", () => {
  it("uses ⟳ for recurring and ⧗ for one-shot", () => {
    expect(kindGlyph(mk({ recurs: true }))).toBe("⟳")
    expect(kindGlyph(mk({ recurs: false }))).toBe("⧗")
  })
})

describe("formatEntry", () => {
  it("leads with the cycle glyph for recurring tasks", () => {
    const s = formatEntry(mk({ recurs: true, label: "every 5m" }), NOW)
    expect(s.startsWith("⟳")).toBe(true)
    expect(s).toContain("every 5m")
    expect(s).toContain("abcd1234")
    assertCleanText(s)
  })
  it("leads with the hourglass glyph for one-shot tasks", () => {
    const s = formatEntry(mk({ recurs: false, label: "at 3pm" }), NOW)
    expect(s.startsWith("⧗")).toBe(true)
    expect(s).not.toContain("⟳")
    assertCleanText(s)
  })
})

describe("formatList", () => {
  it("returns a single line when empty", () => {
    expect(formatList([], NOW)).toEqual(["No scheduled tasks."])
  })
  it("headers the count and lists each task, clean text", () => {
    const lines = formatList([mk(), mk({ id: "zzzz9999", recurs: false })], NOW)
    expect(lines[0]).toContain("2 scheduled tasks")
    for (const l of lines) assertCleanText(l)
  })
})

describe("describeCreated", () => {
  it("leads with the kind glyph and stays clean text", () => {
    const lines = describeCreated(mk({ recurs: true, label: "every 5m" }), NOW, false)
    expect(lines[0]!.startsWith("⟳")).toBe(true)
    for (const l of lines) assertCleanText(l)
  })
})

describe("clipPrompt / cadenceLabel / relativeTime", () => {
  it("clips long prompts to one line", () => {
    expect(clipPrompt("x".repeat(80), 10)).toHaveLength(10)
    expect(clipPrompt("a\n  b   c")).toBe("a b c")
  })
  it("labels cadence from label, then self-paced, then cron", () => {
    expect(cadenceLabel(mk({ label: "every 5m" }))).toBe("every 5m")
    expect(cadenceLabel(mk({ pace: "dynamic" }))).toBe("self-paced")
    expect(cadenceLabel(mk({ cron: "0 9 * * 1-5" }))).toBe("0 9 * * 1-5")
  })
  it("formats relative time compactly", () => {
    expect(relativeTime(NOW, NOW)).toBe("due now")
    expect(relativeTime(NOW + 30_000, NOW)).toBe("in 30s")
    expect(relativeTime(NOW + 5 * 60_000, NOW)).toBe("in 5m")
  })

  it("keeps seconds precision under an hour so live countdowns visibly tick", () => {
    // A minutes-only label looks FROZEN in the footer for up to 60s while
    // the countdown is actually running (user-reported). Sub-hour deltas
    // carry the seconds remainder; exact minutes stay compact.
    expect(relativeTime(NOW + 90_000, NOW)).toBe("in 1m30s")
    expect(relativeTime(NOW + 2 * 60_000 + 1_000, NOW)).toBe("in 2m1s")
    expect(relativeTime(NOW + 59 * 60_000 + 59_000, NOW)).toBe("in 59m59s")
    // Hour+ scales stay coarse (nobody watches those tick).
    expect(relativeTime(NOW + 60 * 60_000, NOW)).toBe("in 1h")
    expect(relativeTime(NOW + 90 * 60_000, NOW)).toBe("in 1h 30m")
  })
})

import { describe, expect, test } from "bun:test"

import { ChoiceModal, type ChoiceOption, wrapText } from "./choice-modal.ts"

function strip(s: string): string {
  // Strip ANSI SGR for content-based assertions.
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

function joined(m: ChoiceModal, width = 60): string {
  return m
    .render(width)
    .map((l) => strip(l))
    .join("\n")
}

const SAMPLE_OPTS: ChoiceOption[] = [
  { id: "strip", label: "Strip thinking", description: "Drop the stale blocks and continue." },
  { id: "switch", label: "Switch model" },
  { id: "cancel", label: "Cancel" },
]

describe("ChoiceModal", () => {
  test("constructor rejects empty options", () => {
    expect(() => new ChoiceModal({ title: "T", body: "B", options: [] })).toThrow(
      /at least one option/,
    )
  })

  test("renders title, body, options, hint", () => {
    const m = new ChoiceModal({
      title: "Model mismatch",
      body: "Old thinking blocks were signed by a different model.",
      options: SAMPLE_OPTS,
    })
    const out = joined(m)
    expect(out).toContain("Model mismatch")
    expect(out).toContain("Old thinking blocks were signed")
    expect(out).toContain("Strip thinking")
    expect(out).toContain("Switch model")
    expect(out).toContain("Cancel")
    expect(out).toContain("← →: navigate")
    expect(out).toContain("Esc: cancel")
  })

  test("default selection is 0; first option is focused", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS })
    expect(m.currentIndex).toBe(0)
    const out = joined(m)
    // Focused option uses ❮ … ❯; non-focused uses [ … ]
    expect(out).toContain("❮ Strip thinking ❯")
  })

  test("right arrow advances selection", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS })
    expect(m.onKey({ name: "right" })).toBe("stay")
    expect(m.currentIndex).toBe(1)
    expect(joined(m)).toContain("❮ Switch model ❯")
  })

  test("tab also advances selection", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS })
    m.onKey({ name: "tab" })
    expect(m.currentIndex).toBe(1)
  })

  test("left arrow wraps around to last", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS })
    m.onKey({ name: "left" })
    expect(m.currentIndex).toBe(2)
    expect(joined(m)).toContain("❮ Cancel ❯")
  })

  test("right arrow wraps from last back to first", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS, defaultIndex: 2 })
    m.onKey({ name: "right" })
    expect(m.currentIndex).toBe(0)
  })

  test("up arrow behaves like left", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS, defaultIndex: 1 })
    m.onKey({ name: "up" })
    expect(m.currentIndex).toBe(0)
  })

  test("down arrow behaves like right", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS })
    m.onKey({ name: "down" })
    expect(m.currentIndex).toBe(1)
  })

  test("enter on focused returns its id", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS, defaultIndex: 1 })
    expect(m.onKey({ name: "enter" })).toEqual({ close: true, result: "switch" })
  })

  test("escape returns null", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS })
    expect(m.onKey({ name: "escape" })).toEqual({ close: true, result: null })
  })

  test("single-char shortcut picks unambiguous option", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS })
    // 'c' uniquely matches Cancel.
    expect(m.onKey({ name: "char", ch: "c" })).toEqual({ close: true, result: "cancel" })
  })

  test("single-char shortcut is case-insensitive", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS })
    expect(m.onKey({ name: "char", ch: "C" })).toEqual({ close: true, result: "cancel" })
  })

  test("ambiguous shortcut is ignored", () => {
    const opts: ChoiceOption[] = [
      { id: "save", label: "Save" },
      { id: "skip", label: "Skip" },
    ]
    const m = new ChoiceModal({ title: "T", body: "B", options: opts })
    // 's' matches both Save and Skip.
    expect(m.onKey({ name: "char", ch: "s" })).toBe("stay")
    expect(m.currentIndex).toBe(0)
  })

  test("non-matching char is ignored", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS })
    expect(m.onKey({ name: "char", ch: "z" })).toBe("stay")
  })

  test("invalid defaultIndex coerced to 0", () => {
    const m = new ChoiceModal({
      title: "T",
      body: "B",
      options: SAMPLE_OPTS,
      defaultIndex: 99,
    })
    expect(m.currentIndex).toBe(0)
    const m2 = new ChoiceModal({
      title: "T",
      body: "B",
      options: SAMPLE_OPTS,
      defaultIndex: -1,
    })
    expect(m2.currentIndex).toBe(0)
  })

  test("focused option description renders, others do not", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS })
    // Strip thinking is focused → its description shows.
    expect(joined(m)).toContain("Drop the stale blocks and continue.")
    m.onKey({ name: "right" })
    // Switch model has no description → no extra line for it.
    expect(joined(m)).not.toContain("Drop the stale blocks and continue.")
  })

  test("destructive option renders a warning glyph", () => {
    const opts: ChoiceOption[] = [
      { id: "delete", label: "Delete all", destructive: true },
      { id: "cancel", label: "Cancel" },
    ]
    const m = new ChoiceModal({ title: "T", body: "B", options: opts })
    expect(joined(m)).toContain("⚠ Delete all")
  })

  test("long body word-wraps to width", () => {
    const longBody =
      "The session inherited thinking blocks from claude-opus-4-7 but the current request targets claude-opus-4-8."
    const m = new ChoiceModal({ title: "T", body: longBody, options: SAMPLE_OPTS })
    const out = m.render(40)
    // Each rendered line should fit (interior content ≤ width-4 cells).
    for (const line of out) {
      const stripped = strip(line)
      expect(stripped.length).toBeLessThanOrEqual(40)
    }
  })

  test("\\n in body forces paragraph break", () => {
    const m = new ChoiceModal({
      title: "T",
      body: "Para one.\nPara two.",
      options: SAMPLE_OPTS,
    })
    const out = joined(m)
    expect(out).toContain("Para one.")
    expect(out).toContain("Para two.")
  })

  test("rowsHint matches actual render row count", () => {
    const m = new ChoiceModal({
      title: "Hello",
      body: "Some body text.",
      options: SAMPLE_OPTS,
    })
    const rendered = m.render(60)
    expect(m.rowsHint()).toBe(rendered.length)
  })

  test("unknown keys are no-ops", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS })
    const before = joined(m)
    expect(m.onKey({ name: "ctrl", ch: "C" })).toBe("stay")
    expect(joined(m)).toBe(before)
  })

  test("very narrow width is clamped to MIN_INNER_WIDTH+4", () => {
    const m = new ChoiceModal({ title: "T", body: "B", options: SAMPLE_OPTS })
    // Width=5 should be clamped up so the modal renders SOMETHING usable.
    const out = m.render(5)
    expect(out.length).toBeGreaterThan(0)
    // First and last rows should be border lines.
    expect(out[0]?.startsWith("╭")).toBe(true)
    expect(out[out.length - 1]?.startsWith("╰")).toBe(true)
  })
})

describe("wrapText", () => {
  test("wraps long line on word boundaries", () => {
    const result = wrapText("the quick brown fox jumps over the lazy dog", 12)
    for (const line of result) expect(line.length).toBeLessThanOrEqual(12)
    expect(result.join(" ")).toBe("the quick brown fox jumps over the lazy dog")
  })

  test("returns single line when within width", () => {
    expect(wrapText("hello", 10)).toEqual(["hello"])
  })

  test("empty string yields a single empty line", () => {
    expect(wrapText("", 10)).toEqual([""])
  })

  test("a single word longer than width gets its own row", () => {
    const result = wrapText("supercalifragilistic", 10)
    expect(result).toEqual(["supercalifragilistic"])
  })

  test("normalizes multiple whitespace", () => {
    const result = wrapText("a   b\t c", 80)
    expect(result).toEqual(["a b c"])
  })
})

/**
 * Byte-exact unit tests for the queued-message decoration block builder.
 *
 * Closes the "Bug 4: zero coverage for renderDecoration" entry in
 * work/TODO-queue-bugs.md. Tests pin the visual shape that the user
 * reported as broken (May 2026):
 *   - per-row numbering (`1`, `2`, `3`, …)
 *   - `▸` separator between number and preview (BUG ▸-pick)
 *   - last visible row closes with `╰` like a tool block
 *   - overflow tail (`... and N more`) carries `╰`
 *   - cap at 10 (BUG 19283), not 3
 *   - alignment: item content column matches header content column
 */
import { describe, expect, it } from "bun:test"

import { displayWidth } from "../../../term-width.ts"

import {
  buildQueueDecorationLines,
  QUEUE_ITEM_SEPARATOR,
  QUEUE_MAX_VISIBLE_ITEMS,
  QUEUE_PREVIEW_W,
} from "./queue-decoration.ts"

/** Strip ANSI SGR escapes for shape assertions. */
const noAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("buildQueueDecorationLines", () => {
  it("returns [] for empty queue (no decoration when nothing pending)", () => {
    expect(buildQueueDecorationLines([])).toEqual([])
  })

  it("single entry: header + closing ╰ on the one item row", () => {
    const lines = buildQueueDecorationLines(["only one"])
    expect(lines.length).toBe(2)
    expect(noAnsi(lines[0])).toBe("  ⏳ queued · 1  ·  ↑ edit")
    expect(noAnsi(lines[1])).toBe("  ╰  1 ▸ only one")
  })

  it("two entries: first row ┊, second row ╰ (last item closes)", () => {
    const lines = buildQueueDecorationLines(["first", "second"])
    expect(lines.length).toBe(3)
    expect(noAnsi(lines[0])).toBe("  ⏳ queued · 2  ·  ↑ edit")
    expect(noAnsi(lines[1])).toBe("  ┊  1 ▸ first")
    expect(noAnsi(lines[2])).toBe("  ╰  2 ▸ second")
  })

  it("three entries: three numbered rows, last is ╰ (well within cap)", () => {
    const lines = buildQueueDecorationLines(["a", "b", "c"])
    expect(lines.length).toBe(4)
    expect(noAnsi(lines[0])).toBe("  ⏳ queued · 3  ·  ↑ edit")
    expect(noAnsi(lines[1])).toBe("  ┊  1 ▸ a")
    expect(noAnsi(lines[2])).toBe("  ┊  2 ▸ b")
    expect(noAnsi(lines[3])).toBe("  ╰  3 ▸ c")
  })

  it("ten entries exactly at the cap: ten numbered rows, last is ╰", () => {
    const queue = Array.from({ length: 10 }, (_, i) => `item-${i + 1}`)
    const lines = buildQueueDecorationLines(queue)
    expect(lines.length).toBe(11) // header + 10 items, no overflow tail
    expect(noAnsi(lines[0])).toBe("  ⏳ queued · 10  ·  ↑ edit")
    expect(noAnsi(lines[1])).toBe("  ┊  1 ▸ item-1")
    expect(noAnsi(lines[9])).toBe("  ┊  9 ▸ item-9")
    expect(noAnsi(lines[10])).toBe("  ╰  10 ▸ item-10")
  })

  it("overflow (>10): ten ┊ item rows, tail carries ╰ ... and N more", () => {
    const queue = Array.from({ length: 12 }, (_, i) => `item-${i + 1}`)
    const lines = buildQueueDecorationLines(queue)
    expect(lines.length).toBe(12) // header + 10 items + elision tail
    expect(noAnsi(lines[0])).toBe("  ⏳ queued · 12  ·  ↑ edit")
    expect(noAnsi(lines[1])).toBe("  ┊  1 ▸ item-1")
    expect(noAnsi(lines[10])).toBe("  ┊  10 ▸ item-10")
    expect(noAnsi(lines[11])).toBe("  ╰  ... and 2 more")
  })

  it("FIFO order: first queued is row 1", () => {
    const lines = buildQueueDecorationLines(["zebra", "apple"])
    expect(noAnsi(lines[1]).endsWith(" 1 ▸ zebra")).toBe(true)
    expect(noAnsi(lines[2]).endsWith(" 2 ▸ apple")).toBe(true)
  })

  it("collapses internal whitespace in preview", () => {
    const lines = buildQueueDecorationLines(["multi\n   line   text"])
    expect(noAnsi(lines[1])).toBe("  ╰  1 ▸ multi line text")
  })

  it("trims leading/trailing whitespace in preview", () => {
    const lines = buildQueueDecorationLines(["   padded   "])
    expect(noAnsi(lines[1])).toBe("  ╰  1 ▸ padded")
  })

  it("truncates long previews with (+Nch) hint, preserves prefix", () => {
    const long = "x".repeat(120)
    const item = noAnsi(buildQueueDecorationLines([long])[1])
    expect(item.startsWith("  ╰  1 ▸ ")).toBe(true)
    expect(item).toContain("(+")
    expect(item).toContain("ch)")
    // The preview itself is at most QUEUE_PREVIEW_W cells (truncation
    // happens BEFORE the hint suffix, so the body proper fits the cap).
    const body = item.slice("  ╰  1 ▸ ".length)
    const hintIdx = body.lastIndexOf("(+")
    const previewBody = body.slice(0, body.lastIndexOf("...(", hintIdx))
    expect(displayWidth(previewBody) <= QUEUE_PREVIEW_W).toBe(true)
  })

  it("item-row prefix: 2 spaces + glyph + 2 spaces + num + space + ▸ + space", () => {
    // The two-space gap after the 1-cell `┊` / `╰` glyph is deliberate:
    // it compensates for the header's `⏳` rendering as 2 cells in
    // iTerm / WezTerm / most modern terminals, even though the
    // codebase's `displayWidth` (term-width.ts) currently scores it
    // at 1 cell. The byte tests above already pin the visible shape;
    // this case just locks the prefix length so future "simplify the
    // padding" edits trigger a test failure rather than silently
    // re-introducing the alignment bug the May 2026 fix addressed.
    const item = noAnsi(buildQueueDecorationLines(["x"])[1])
    expect(item.startsWith("  ╰  1 ▸ ")).toBe(true)
    expect(item).toBe("  ╰  1 ▸ x")
  })

  it("separator constant is the BLACK RIGHT-POINTING SMALL TRIANGLE", () => {
    expect(QUEUE_ITEM_SEPARATOR).toBe("▸")
    expect(QUEUE_ITEM_SEPARATOR.codePointAt(0)).toBe(0x25b8)
  })

  it("colors the header in violet (non-dim) and dims the badge count", () => {
    const lines = buildQueueDecorationLines(["a"])
    // Header: violet ⏳ + violet "queued" + faintWhite "· 1"
    // Violet is truecolor rgb(180, 140, 255) — matches mdstream inline-code.
    expect(lines[0]).toContain("\x1b[38;2;180;140;255m") // violet open (⏳ and "queued")
    expect(lines[0]).toContain("\x1b[39m") // violet close
    expect(lines[0]).toContain("\x1b[2;37m") // faintWhite "· N" open
    expect(lines[0]).toContain("\x1b[22;39m") // faintWhite close
    // Header MUST NOT be in the yellow/gold family — guards against
    // future accidental refactor to gold/yellow/orange.
    expect(lines[0]).not.toContain("\x1b[33m") // yellow
    expect(lines[0]).not.toContain("\x1b[93m") // bright yellow
    expect(lines[0]).not.toContain("\x1b[38;5;214m") // gold
    expect(lines[0]).not.toContain("\x1b[38;5;208m") // orange
  })

  it("item rows: dim glyph, dim-violet number, dim ▸, faintWhite preview", () => {
    const lines = buildQueueDecorationLines(["a"])
    // glyph + separator wrapped in plain dim
    expect(lines[1]).toContain("\x1b[2m") // dim open (glyph + ▸)
    expect(lines[1]).toContain("\x1b[22m") // dim close
    // row number is dim-violet (combined SGR open)
    expect(lines[1]).toContain("\x1b[2;38;2;180;140;255m") // dim-violet open (truecolor)
    expect(lines[1]).toContain("\x1b[22;39m") // dim-violet close (also matches faintWhite close)
    // preview is faintWhite
    expect(lines[1]).toContain("\x1b[2;37m") // faintWhite preview open
  })

  it("overflow tail uses faintWhite (matches preview row tone)", () => {
    const queue = Array.from({ length: 15 }, (_, i) => `item-${i + 1}`)
    const lines = buildQueueDecorationLines(queue)
    const tail = lines[lines.length - 1]
    expect(tail).toContain("\x1b[2m") // dim glyph
    expect(tail).toContain("\x1b[2;37m") // faintWhite tail text
  })

  it("cap constant matches the visible-rows behavior (bumped to 10 in BUG 19283)", () => {
    expect(QUEUE_MAX_VISIBLE_ITEMS).toBe(10)
  })

  it("preview cap constant matches truncation behavior", () => {
    expect(QUEUE_PREVIEW_W).toBe(70)
  })
})

describe("buildQueueDecorationLines — ↑ edit affordance", () => {
  it("plain header carries a faint '↑ edit' discoverability hint", () => {
    const lines = buildQueueDecorationLines(["a", "b"])
    expect(noAnsi(lines[0])).toBe("  ⏳ queued · 2  ·  ↑ edit")
    // The affordance is dim, not a fresh accent color.
    expect(lines[0]).toContain("\x1b[2m")
  })

  it("nav header omits the affordance (the hint row covers actions)", () => {
    const lines = buildQueueDecorationLines(["a", "b"], { selectedIndex: 0 })
    expect(noAnsi(lines[0])).toBe("  ⏳ queued · 2")
    expect(noAnsi(lines[0])).not.toContain("↑ edit")
  })
})

describe("buildQueueDecorationLines — navigation mode (selectedIndex)", () => {
  it("selectedIndex null behaves exactly like the plain block", () => {
    const plain = buildQueueDecorationLines(["a", "b"])
    const explicitNull = buildQueueDecorationLines(["a", "b"], { selectedIndex: null })
    expect(explicitNull).toEqual(plain)
  })

  it("renders a hint row (carrying ╰) with the d / x / k / esc actions", () => {
    const lines = buildQueueDecorationLines(["a", "b", "c"], { selectedIndex: 1 })
    const hint = noAnsi(lines[lines.length - 1])
    expect(hint).toContain("╰")
    expect(hint).toContain("↑↓ select")
    expect(hint).toContain("d dequeue")
    expect(hint).toContain("x remove")
    expect(hint).toContain("k dequeue all")
    expect(hint).toContain("esc cancel")
  })

  it("item rows use ┊ (hint row closes the block, not the last item)", () => {
    const lines = buildQueueDecorationLines(["a", "b", "c"], { selectedIndex: 0 })
    // header + 3 items + hint
    expect(lines.length).toBe(5)
    expect(noAnsi(lines[1]).includes("╰")).toBe(false)
    expect(noAnsi(lines[2]).includes("╰")).toBe(false)
    expect(noAnsi(lines[3]).includes("╰")).toBe(false)
    expect(noAnsi(lines[4]).includes("╰")).toBe(true) // hint row
  })

  it("selected row uses the ▌ marker and a violet background bar", () => {
    const lines = buildQueueDecorationLines(["a", "b"], { selectedIndex: 1 })
    const selected = lines[2] // header(0) + item-1(1) + item-2 selected(2)
    expect(noAnsi(selected)).toContain("▌  2 ▸ b")
    expect(selected).toContain("\x1b[48;2;55;45;85m") // bg open
    expect(selected).toContain("\x1b[49m") // bg close (background-only reset)
    // Non-selected rows keep the plain ┊ marker, no background.
    expect(noAnsi(lines[1])).toContain("┊  1 ▸ a")
    expect(lines[1]).not.toContain("\x1b[48;2;55;45;85m")
  })

  it("with cols, the selected row is right-padded to a full-width bar", () => {
    const cols = 50
    const lines = buildQueueDecorationLines(["short", "x"], { selectedIndex: 0, cols })
    const selected = lines[1]
    // Visible width of the bar equals the terminal width.
    expect(displayWidth(noAnsi(selected))).toBe(cols)
    // The trailing pad sits INSIDE the background (bg-close is the last SGR).
    expect(selected.endsWith("\x1b[49m")).toBe(true)
  })

  it("without cols, the selected row carries the bar but is not padded", () => {
    const lines = buildQueueDecorationLines(["short", "x"], { selectedIndex: 0 })
    const selected = lines[1]
    expect(selected).toContain("\x1b[48;2;55;45;85m")
    // No giant pad run : visible width is just the content, well under 80.
    expect(displayWidth(noAnsi(selected))).toBeLessThan(20)
  })

  it("clamps an out-of-range selectedIndex into the queue", () => {
    const lines = buildQueueDecorationLines(["a", "b"], { selectedIndex: 99 })
    // Last item (index 1) ends up selected.
    expect(noAnsi(lines[2])).toContain("▌  2 ▸ b")
  })

  it("windows a deep queue around the selection with ↑/↓ more elisions", () => {
    const queue = Array.from({ length: 14 }, (_, i) => `item-${i + 1}`)
    const lines = buildQueueDecorationLines(queue, { selectedIndex: 12 })
    const plain = lines.map(noAnsi)
    // header + (↑ more) + 10 rows + hint  (selection near the bottom, so
    // the window clips the top and the bottom edge reaches the last item)
    expect(plain[0]).toBe("  ⏳ queued · 14")
    expect(plain[1]).toContain("↑ 4 more")
    expect(plain.some((l) => l.includes("▌  13 ▸ item-13"))).toBe(true)
    expect(plain[plain.length - 1]).toContain("↑↓ select")
    // No "↓ N more" elision : the window already reaches item-14. (The
    // hint row's "↑↓ select" contains ↓, so match the elision shape.)
    expect(plain.some((l) => /↓ \d+ more/.test(l))).toBe(false)
    expect(plain.some((l) => /↑ \d+ more/.test(l))).toBe(true)
  })

  it("windowing keeps the selection visible with BOTH elisions mid-queue", () => {
    const queue = Array.from({ length: 30 }, (_, i) => `item-${i + 1}`)
    const lines = buildQueueDecorationLines(queue, { selectedIndex: 15 })
    const plain = lines.map(noAnsi)
    expect(plain.some((l) => /↑ \d+ more/.test(l))).toBe(true)
    expect(plain.some((l) => /↓ \d+ more/.test(l))).toBe(true)
    expect(plain.some((l) => l.includes("▌  16 ▸ item-16"))).toBe(true)
  })
})

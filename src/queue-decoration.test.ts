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
import {
  buildQueueDecorationLines,
  QUEUE_ITEM_SEPARATOR,
  QUEUE_MAX_VISIBLE_ITEMS,
  QUEUE_PREVIEW_W,
} from "./queue-decoration.ts"
import { displayWidth } from "./term-width.ts"

/** Strip ANSI SGR escapes for shape assertions. */
const noAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("buildQueueDecorationLines", () => {
  it("returns [] for empty queue (no decoration when nothing pending)", () => {
    expect(buildQueueDecorationLines([])).toEqual([])
  })

  it("single entry: header + closing ╰ on the one item row", () => {
    const lines = buildQueueDecorationLines(["only one"])
    expect(lines.length).toBe(2)
    expect(noAnsi(lines[0])).toBe("  ⏳ queued · 1")
    expect(noAnsi(lines[1])).toBe("  ╰  1 ▸ only one")
  })

  it("two entries: first row ┊, second row ╰ (last item closes)", () => {
    const lines = buildQueueDecorationLines(["first", "second"])
    expect(lines.length).toBe(3)
    expect(noAnsi(lines[0])).toBe("  ⏳ queued · 2")
    expect(noAnsi(lines[1])).toBe("  ┊  1 ▸ first")
    expect(noAnsi(lines[2])).toBe("  ╰  2 ▸ second")
  })

  it("three entries: three numbered rows, last is ╰ (well within cap)", () => {
    const lines = buildQueueDecorationLines(["a", "b", "c"])
    expect(lines.length).toBe(4)
    expect(noAnsi(lines[0])).toBe("  ⏳ queued · 3")
    expect(noAnsi(lines[1])).toBe("  ┊  1 ▸ a")
    expect(noAnsi(lines[2])).toBe("  ┊  2 ▸ b")
    expect(noAnsi(lines[3])).toBe("  ╰  3 ▸ c")
  })

  it("ten entries exactly at the cap: ten numbered rows, last is ╰", () => {
    const queue = Array.from({ length: 10 }, (_, i) => `item-${i + 1}`)
    const lines = buildQueueDecorationLines(queue)
    expect(lines.length).toBe(11) // header + 10 items, no overflow tail
    expect(noAnsi(lines[0])).toBe("  ⏳ queued · 10")
    expect(noAnsi(lines[1])).toBe("  ┊  1 ▸ item-1")
    expect(noAnsi(lines[9])).toBe("  ┊  9 ▸ item-9")
    expect(noAnsi(lines[10])).toBe("  ╰  10 ▸ item-10")
  })

  it("overflow (>10): ten ┊ item rows, tail carries ╰ ... and N more", () => {
    const queue = Array.from({ length: 12 }, (_, i) => `item-${i + 1}`)
    const lines = buildQueueDecorationLines(queue)
    expect(lines.length).toBe(12) // header + 10 items + elision tail
    expect(noAnsi(lines[0])).toBe("  ⏳ queued · 12")
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

  it("dims the glyph and content wrappers (ESC[2m … ESC[22m)", () => {
    const lines = buildQueueDecorationLines(["a"])
    expect(lines[0]).toContain("\x1b[2;37m") // faintWhite ⏳ open
    expect(lines[0]).toContain("\x1b[22;39m") // faintWhite close
    expect(lines[0]).toContain("\x1b[2m") // dim "queued · N" open
    expect(lines[1]).toContain("\x1b[2m") // dim glyph + content
    expect(lines[1]).toContain("\x1b[22m") // dim close
  })

  it("cap constant matches the visible-rows behavior (bumped to 10 in BUG 19283)", () => {
    expect(QUEUE_MAX_VISIBLE_ITEMS).toBe(10)
  })

  it("preview cap constant matches truncation behavior", () => {
    expect(QUEUE_PREVIEW_W).toBe(70)
  })
})

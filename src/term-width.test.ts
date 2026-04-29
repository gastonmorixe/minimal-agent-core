import { describe, expect, it } from "bun:test"
import {
  codePointWidth,
  cursorRowOffset,
  cursorVisualCol,
  displayWidth,
  stripAnsi,
  truncateDisplayWidth,
  wrapRows,
} from "./term-width.ts"

describe("term-width", () => {
  it("strips CSI / SGR escapes", () => {
    expect(stripAnsi("\x1b[1;36m❯\x1b[22;39m ")).toBe("❯ ")
  })

  it("counts ASCII as one cell each", () => {
    expect(displayWidth("hello")).toBe(5)
  })

  it("ignores ANSI when measuring", () => {
    expect(displayWidth("\x1b[1;36m❯\x1b[22;39m ")).toBe(2)
  })

  it("treats combining marks as zero-width", () => {
    // 'é' decomposed as e + U+0301
    expect(displayWidth("e\u0301")).toBe(1)
  })

  it("treats variation selectors as zero-width", () => {
    // heart + VS16 (renders as red emoji heart but still 1 cell-ish; we
    // model the heart itself as width 1 + VS as 0).
    expect(codePointWidth(0xfe0f)).toBe(0)
  })

  it("treats CJK as width 2", () => {
    expect(displayWidth("漢字")).toBe(4)
  })

  it("treats common emoji as width 2", () => {
    expect(displayWidth("🙂")).toBe(2)
  })

  it("wrapRows handles the exact-fill case", () => {
    expect(wrapRows(0, 80)).toBe(1)
    expect(wrapRows(1, 80)).toBe(1)
    expect(wrapRows(80, 80)).toBe(1)
    expect(wrapRows(81, 80)).toBe(2)
    expect(wrapRows(160, 80)).toBe(2)
    expect(wrapRows(161, 80)).toBe(3)
  })

  it("cursorRowOffset keeps an exact-fill cursor on the current row", () => {
    expect(cursorRowOffset(2, 0, 80)).toBe(0)
    expect(cursorRowOffset(2, 78, 80)).toBe(0) // total=80, edge of row 0
    expect(cursorRowOffset(2, 79, 80)).toBe(1) // total=81, wrapped
    expect(cursorRowOffset(0, 80, 80)).toBe(0) // exact-fill stays on row 0
    expect(cursorRowOffset(0, 81, 80)).toBe(1)
  })

  it("cursorVisualCol returns the right edge for exact-fill", () => {
    expect(cursorVisualCol(0, 0, 80)).toBe(0)
    expect(cursorVisualCol(0, 80, 80)).toBe(80)
    expect(cursorVisualCol(2, 78, 80)).toBe(80)
    expect(cursorVisualCol(2, 79, 80)).toBe(1)
  })

  it("truncateDisplayWidth clips text to terminal cells", () => {
    expect(truncateDisplayWidth("abcdefghij", 8)).toBe("abcde...")
    expect(displayWidth(truncateDisplayWidth("ab漢字cd", 7))).toBeLessThanOrEqual(7)
  })

  it("truncateDisplayWidth preserves ANSI escapes without counting them", () => {
    const out = truncateDisplayWidth("\x1b[31mabcdefghij\x1b[0m", 8)
    expect(stripAnsi(out)).toBe("abcde...")
    expect(displayWidth(out)).toBe(8)
    expect(out).toContain("\x1b[31m")
    expect(out).toContain("\x1b[0m")
  })
})

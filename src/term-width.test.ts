import { describe, expect, it } from "bun:test"
import {
  codePointWidth,
  cursorRowOffset,
  cursorVisualCol,
  displayWidth,
  expandTabs,
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

  it("treats Private Use Area codepoints as width 1 (font-config dependent)", () => {
    // PUA cell width is NOT hard-coded to 2: a patched Nerd Font
    // renders these as 2 cells, but iTerm + an unpatched fallback
    // font renders them as 1. Hard-coding "PUA = 2" jiggles the
    // other case. We treat them as 1 (the safer default) and rely
    // on byte-width-stable spinner pulses for layout stability.
    expect(codePointWidth(0xe000)).toBe(1)
    expect(codePointWidth(0xf07b)).toBe(1) // nf-fa-folder
    expect(codePointWidth(0xf8ff)).toBe(1)
    expect(codePointWidth(0xf0000)).toBe(1)
    expect(codePointWidth(0xf1064)).toBe(1) // nf-md-tools 󱁤
    expect(codePointWidth(0x100000)).toBe(1)
    expect(displayWidth("\u{F1064}")).toBe(1)
    expect(displayWidth("\u{F1064} label")).toBe(7) // 1 + 1 + 5
  })

  it("non-PUA spinner frames also count as width 1", () => {
    expect(codePointWidth(0x25cf)).toBe(1)
    expect(displayWidth("●")).toBe(1)
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

describe("expandTabs", () => {
  it("passes through text with no tabs verbatim", () => {
    expect(expandTabs("hello world", 0)).toBe("hello world")
    expect(expandTabs("", 4)).toBe("")
    expect(expandTabs("\x1b[31mred\x1b[0m", 0)).toBe("\x1b[31mred\x1b[0m")
  })

  it("expands a tab at startCol=0 to a full tabSize-wide run", () => {
    // From col 0, tab lands at col 8 → 8 spaces.
    expect(expandTabs("\tx", 0)).toBe("        x")
  })

  it("expands a tab so the next character lands at the next tab stop", () => {
    // After gutter (4 cells) + "3" (1 cell), cursor is at col 5.
    // Next tab stop is col 8 → 3 spaces of fill. This is the Read
    // tool's exact case (`<linenum>\t<content>`).
    expect(expandTabs("3\tcontent", 4)).toBe("3   content")
  })

  it("handles consecutive tabs", () => {
    // From col 0: tab → col 8 (8 sp), tab → col 16 (8 sp).
    expect(expandTabs("\t\tx", 0)).toBe(" ".repeat(16) + "x")
  })

  it("handles tab landing exactly on a tab stop boundary", () => {
    // From col 0, "12345678" advances to col 8. Tab from col 8 →
    // col 16 (8 cells of fill, not zero).
    expect(expandTabs("12345678\tx", 0)).toBe("12345678" + " ".repeat(8) + "x")
  })

  it("passes ANSI SGR escapes through without affecting column tracking", () => {
    // SGR contributes 0 cells; "3" is 1 cell so tab from col 5 lands
    // at col 8 (3 spaces of fill).
    const out = expandTabs("\x1b[33m3\x1b[0m\tcontent", 4)
    expect(out).toBe("\x1b[33m3\x1b[0m   content")
    // displayWidth ignores the SGR, sees "3" + 3 spaces + "content".
    expect(displayWidth(out)).toBe(1 + 3 + "content".length)
  })

  it("counts wide codepoints as 2 cells when advancing toward the next tab stop", () => {
    // "漢" is width 2. After a wide char starting at col 0, cursor is
    // at col 2. Tab → col 8 (6 spaces of fill).
    expect(expandTabs("漢\tx", 0)).toBe("漢" + " ".repeat(6) + "x")
  })

  it("treats zero-width codepoints as 0 cells when advancing", () => {
    // "e" (1) + combining acute (0) → col 1. Tab from col 1 → col 8
    // (7 spaces of fill).
    expect(expandTabs("e\u0301\tx", 0)).toBe("e\u0301" + " ".repeat(7) + "x")
  })

  it("respects a custom tabSize", () => {
    // tabSize=4: from col 0, tab → col 4 (4 sp).
    expect(expandTabs("\tx", 0, 4)).toBe("    x")
    // From col 5 with tabSize=4: next stop is col 8 (3 sp).
    expect(expandTabs("\tx", 5, 4)).toBe("   x")
  })

  it("clamps a negative startCol to 0", () => {
    // Don't go negative; treat as col 0.
    expect(expandTabs("\tx", -3)).toBe("        x")
  })

  it("produces a string whose displayWidth matches what the terminal renders", () => {
    // The whole point: after expansion, displayWidth(line) +
    // startCol === terminal column the cursor lands at after the
    // line. This is the property the tool-transcript clamp relies on.
    const startCol = 4
    const line = "3\tHow to express classic design patterns"
    const expanded = expandTabs(line, startCol)
    // "3" (1) + tab from col 5 → col 8 (3) + "How to..." (35).
    expect(displayWidth(expanded)).toBe(1 + 3 + "How to express classic design patterns".length)
    expect(expanded).not.toContain("\t")
  })
})

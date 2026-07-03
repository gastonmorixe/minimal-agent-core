import { describe, expect, it } from "bun:test"

import {
  codePointWidth,
  cursorRowOffset,
  cursorVisualCol,
  displayWidth,
  expandTabs,
  stripAnsi,
  truncateDisplayWidth,
  wordWrap,
  wrapIndented,
  wrapRows,
} from "@minimal-agent/plugin-api/utils/term-width"

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

  it("treats BMP Emoji_Presentation glyphs as width 2", () => {
    // Regression: these sit BELOW the 0x1F300 pictograph planes among
    // otherwise-narrow symbol blocks, so the old code measured them as 1
    // cell while every terminal paints them 2 wide. The startup `tools`
    // row's `⏰ CronCreate` chunks drifted because of this (BUG 1).
    expect(codePointWidth(0x23f0)).toBe(2) // ⏰ alarm clock
    expect(displayWidth("⏰")).toBe(2)
    expect(codePointWidth(0x231a)).toBe(2) // ⌚ watch
    expect(codePointWidth(0x26a1)).toBe(2) // ⚡ high voltage
    expect(codePointWidth(0x2705)).toBe(2) // ✅ check mark button
    expect(codePointWidth(0x2b50)).toBe(2) // ⭐ star
    expect(codePointWidth(0x274c)).toBe(2) // ❌ cross mark
    // `⏰ CronList` chunk: 2 (⏰) + 1 (space) + 8 (CronList) = 11.
    expect(displayWidth("⏰ CronList")).toBe(11)
  })

  it("keeps text-default symbols at width 1 (no VS16)", () => {
    // These have an emoji variation sequence but default to TEXT
    // presentation, so a bare code point stays 1 cell. They only go wide
    // when followed by VS16 (which itself contributes 0). Matches the
    // terminal's text-presentation rendering for the startup tree glyphs.
    expect(codePointWidth(0x2714)).toBe(1) // ✔ heavy check mark
    expect(codePointWidth(0x2726)).toBe(1) // ✦ black four pointed star
    expect(codePointWidth(0x276f)).toBe(1) // ❯ prompt chevron
    expect(codePointWidth(0x25cf)).toBe(1) // ● black circle
    expect(codePointWidth(0x00b1)).toBe(1) // ± plus-minus (ShowDiff icon)
    expect(codePointWidth(0x2913)).toBe(1) // ⤓ downwards arrow to bar (Fetch icon)
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

describe("wordWrap", () => {
  it("returns the text as a single line when it fits", () => {
    expect(wordWrap("hello world", 80)).toEqual(["hello world"])
  })

  it("splits on word boundaries", () => {
    const result = wordWrap("the quick brown fox jumps over the lazy dog", 12)
    for (const line of result) expect(displayWidth(line)).toBeLessThanOrEqual(12)
    expect(result.join(" ")).toBe("the quick brown fox jumps over the lazy dog")
  })

  it("returns an empty string for empty input", () => {
    expect(wordWrap("", 80)).toEqual([""])
  })

  it("handles a single word longer than width", () => {
    // With hard-breaking, a word wider than width is split into chunks.
    // "supercalifragilistic" = 20 chars, width=10 → two 10-char chunks.
    const result = wordWrap("supercalifragilistic", 10)
    expect(result.length).toBeGreaterThan(1)
    for (const line of result) expect(displayWidth(line)).toBeLessThanOrEqual(10)
    expect(result.join("")).toBe("supercalifragilistic")
  })

  it("preserves ANSI codes across wrapped lines", () => {
    const result = wordWrap("\x1b[32mthe quick brown fox\x1b[0m", 12)
    // At width 12, "the quick" fits (~9), "brown" starts new line (5)
    // Each continuation should carry the green ANSI prefix.
    for (const line of result) {
      if (line.length > 0) {
        expect(line.startsWith("\x1b[32m") || line.startsWith("the")).toBe(true)
      }
    }
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it("handles width <= 0 by returning the text as-is", () => {
    const input = "some text"
    expect(wordWrap(input, 0)).toEqual([input])
    expect(wordWrap(input, -1)).toEqual([input])
  })

  it("pads nothing if the text displayWidth is <= width", () => {
    expect(wordWrap("short", 100)).toEqual(["short"])
  })

  it("handles text with multiple spaces between words", () => {
    const result = wordWrap("a   b    c", 80)
    // Multiple whitespace should be collapsed
    expect(result.join(" ").replace(/\s+/g, " ")).toBe("a b c")
  })

  it("places consecutive lines within width even for complex inputs", () => {
    // Long text that wraps many times; verify every line fits
    const text = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ")
    const result = wordWrap(text, 30)
    for (const line of result) {
      expect(displayWidth(line)).toBeLessThanOrEqual(30)
    }
  })

  it("handles mixed CJK and ASCII", () => {
    const result = wordWrap("hello 世界 world foo bar", 10)
    for (const line of result) expect(displayWidth(line)).toBeLessThanOrEqual(10)
    // All tokens preserved in order
    const joined = result.join(" ").replace(/\s+/g, " ")
    expect(joined).toContain("hello")
    expect(joined).toContain("世界")
    expect(joined).toContain("world")
    expect(joined).toContain("foo")
    expect(joined).toContain("bar")
  })

  it("handles ANSI appearing mid-word-token (ANSI boundary is a word boundary)", () => {
    // The tokenizer treats ANSI sequences as word boundaries because ANSI
    // between text characters flushes the preceding word. "he\x1b[31mllo"
    // tokenizes as ["he", "\x1b[31mllo"] — both tokens are short enough
    // that they should fit even at width=10.
    const result = wordWrap("he\x1b[31mllo", 10)
    expect(result.length).toBe(1)
    expect(result[0]).toContain("\x1b[31m")
  })

  it("handles width boundary case: width=1", () => {
    const result = wordWrap("a b c", 1)
    for (const line of result) expect(displayWidth(line)).toBeLessThanOrEqual(1)
    expect(result.length).toBe(3)
    expect(result.join("")).toBe("abc")
  })

  it("handles width boundary case: width equal to a word", () => {
    const result = wordWrap("hello world foo", 5)
    for (const line of result) expect(displayWidth(line)).toBeLessThanOrEqual(5)
    // Each word is exactly 5 or 3 chars, so they should each fit
    expect(result).toContain("hello")
    expect(result).toContain("world")
    expect(result).toContain("foo")
  })
})

describe("wrapIndented", () => {
  it("returns the line unchanged when it already fits", () => {
    expect(wrapIndented("  ╰  ✔  #abc  short title", 80)).toEqual(["  ╰  ✔  #abc  short title"])
  })

  it("returns the line as-is for width <= 0", () => {
    const line = "  ╰  ✔  #abc  a long title that would otherwise wrap"
    expect(wrapIndented(line, 0)).toEqual([line])
    expect(wrapIndented(line, -5)).toEqual([line])
  })

  it("preserves the leading column spacing on the first fragment", () => {
    // A task-style row: 1 space + number col + glyph + id + title.
    const line = " 4 ✔ #77829c Update prompts/templates where appropriate avoid overuse"
    const result = wrapIndented(line, 40)
    expect(result.length).toBeGreaterThan(1)
    // First fragment keeps the exact leading "  4 ✔ ..." columns.
    expect(result[0].startsWith(" 4 ✔ #77829c Update")).toBe(true)
    // No fragment exceeds the width.
    for (const frag of result) expect(displayWidth(frag)).toBeLessThanOrEqual(40)
  })

  it("hang-indents continuation fragments to the leading whitespace width", () => {
    // 6 leading spaces (subtask-style indent). Continuations should be
    // indented by 6 spaces too.
    const line = "      ╰  ✔  #f998aec scanner tests plus integration test for emit output module"
    const result = wrapIndented(line, 50)
    expect(result.length).toBeGreaterThan(1)
    for (let i = 1; i < result.length; i++) {
      expect(result[i].startsWith("      ")).toBe(true)
      // Indent is exactly the 6-space lead, not deeper.
      expect(result[i].startsWith("       ")).toBe(false)
    }
  })

  it("uses an explicit hang indent when provided", () => {
    const line = "1 ✔ #abc the quick brown fox jumps over the lazy dog repeatedly today"
    const result = wrapIndented(line, 30, 4)
    expect(result.length).toBeGreaterThan(1)
    for (let i = 1; i < result.length; i++) {
      expect(result[i].startsWith("    ")).toBe(true)
      expect(result[i].startsWith("     ")).toBe(false)
    }
  })

  it("keeps every fragment within the width", () => {
    const line =
      " 14 ✔ #773988 Verify the build lint and full test suite all pass cleanly across the whole repository before declaring victory"
    const result = wrapIndented(line, 40)
    for (const frag of result) expect(displayWidth(frag)).toBeLessThanOrEqual(40)
  })

  it("loses no title words across the wrap", () => {
    const line = " 3 ✔ #f998ae Add and update tests for the emit output feature end to end"
    const result = wrapIndented(line, 28)
    const flat = result.join(" ").replace(/\s+/g, " ").trim()
    // Every original word survives (order preserved by join).
    for (const word of line.trim().split(/\s+/)) {
      expect(flat).toContain(word)
    }
  })

  it("preserves ANSI styling and never leaves a style unclosed", () => {
    // Title span is green; the wrap must re-anchor the color on the
    // continuation and close it at each fragment end.
    const line = "  ╰  #abc  \x1b[32mthe quick brown fox jumps over the lazy dog again\x1b[0m"
    const result = wrapIndented(line, 24)
    expect(result.length).toBeGreaterThan(1)
    for (const frag of result) {
      expect(displayWidth(frag)).toBeLessThanOrEqual(24)
      // If a fragment opens a color, it must also reset it.
      if (frag.includes("\x1b[32m")) expect(frag.includes("\x1b[0m")).toBe(true)
    }
    // The continuation fragment carries the green style forward.
    expect(result.some((f, i) => i > 0 && f.includes("\x1b[32m"))).toBe(true)
  })

  it("falls back to hard-breaking a single unbreakable token", () => {
    const line = "supercalifragilisticexpialidocious"
    const result = wrapIndented(line, 10)
    expect(result.length).toBeGreaterThan(1)
    for (const frag of result) expect(displayWidth(frag)).toBeLessThanOrEqual(10)
    expect(result.join("")).toBe(line)
  })

  it("caps the hang indent so narrow terminals keep usable width", () => {
    // 20 leading spaces but width 16: indent must be capped (<= max(8, 8))
    // so continuations still have room for text.
    const line = `${" ".repeat(20)}alpha beta gamma delta epsilon zeta`
    const result = wrapIndented(line, 16)
    for (const frag of result) expect(displayWidth(frag)).toBeLessThanOrEqual(16)
    // Continuation indent is capped at 8, not the full 20.
    for (let i = 1; i < result.length; i++) {
      expect(displayWidth(frag_lead(result[i]))).toBeLessThanOrEqual(8)
    }
  })
})

/** Helper: leading-space prefix of a fragment (for indent assertions). */
function frag_lead(s: string): string {
  const m = s.match(/^ */)
  return m ? m[0] : ""
}

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

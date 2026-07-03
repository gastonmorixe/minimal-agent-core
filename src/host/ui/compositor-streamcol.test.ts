/**
 * Regression for B2 — `Compositor.updateStreamCol` must measure
 * display cells (not codepoints), so that `eraseLiveSeq` lands on the
 * actual end-of-line column even when the partial stream contains
 * wide East-Asian glyphs, emoji, or combining marks.
 *
 * The current implementation uses `Array.from(stripped).length` which
 * miscounts every wide glyph by 1.
 */

import { describe, expect, it } from "bun:test"

import { displayWidth } from "../../terminal/term-width.ts"

import { updateStreamCol } from "./compositor.ts"

describe("updateStreamCol", () => {
  it("ASCII-only chunks: matches both codepoint count and display width", () => {
    expect(updateStreamCol("hello", 0)).toBe(5)
    expect(updateStreamCol(" world", 5)).toBe(11)
  })

  it("CRLF resets the running column", () => {
    expect(updateStreamCol("foo\r\nbar", 10)).toBe(3)
    expect(updateStreamCol("\n", 7)).toBe(0)
    expect(updateStreamCol("\r", 7)).toBe(0)
  })

  it("strips ANSI SGR sequences before measuring", () => {
    expect(updateStreamCol("\x1b[1mbold\x1b[0m", 0)).toBe(4)
  })

  it("CJK glyph counts as two cells, not one codepoint", () => {
    const s = "日本"
    expect(updateStreamCol(s, 0)).toBe(displayWidth(s))
    expect(updateStreamCol(s, 0)).toBe(4)
  })

  it("emoji counts as two cells", () => {
    const s = "🚀"
    expect(updateStreamCol(s, 0)).toBe(displayWidth(s))
    expect(updateStreamCol(s, 0)).toBe(2)
  })

  it("combining marks contribute zero cells", () => {
    const s = "e\u0301" // é via combining acute
    expect(updateStreamCol(s, 0)).toBe(displayWidth(s))
    expect(updateStreamCol(s, 0)).toBe(1)
  })

  it("returns the visual cursor column after terminal wrapping", () => {
    expect(updateStreamCol("abcdef", 0, 5)).toBe(1)
    expect(updateStreamCol("abcde", 0, 5)).toBe(5)
    expect(updateStreamCol("x", 5, 5)).toBe(1)
    expect(updateStreamCol("abc\nabcdef", 4, 5)).toBe(1)
  })

  it("mixed prose with ❯ ... — still matches displayWidth", () => {
    const s = "❯ stream... —"
    expect(updateStreamCol(s, 0)).toBe(displayWidth(s))
  })
})

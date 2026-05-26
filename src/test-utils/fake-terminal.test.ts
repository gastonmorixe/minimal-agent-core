import { describe, expect, it } from "bun:test"

import { FakeTerminal } from "./fake-terminal.ts"

describe("FakeTerminal — printable text + CR/LF", () => {
  it("prints a line and advances the cursor", () => {
    const t = new FakeTerminal({ cols: 20, rows: 5 })
    t.feed("hello")
    expect(t.screen()[0]).toBe("hello")
    expect(t.cursor()).toEqual({ row: 0, col: 5 })
  })

  it("CR returns to col 0; LF advances row", () => {
    const t = new FakeTerminal({ cols: 20, rows: 5 })
    t.feed("hello\r\nworld")
    expect(t.screen()[0]).toBe("hello")
    expect(t.screen()[1]).toBe("world")
  })

  it("CR alone overwrites in place", () => {
    const t = new FakeTerminal({ cols: 20, rows: 5 })
    t.feed("hello world\rABC")
    expect(t.screen()[0]).toBe("ABClo world")
  })

  it("scroll: writing past the bottom row pushes the top to scrollback", () => {
    const t = new FakeTerminal({ cols: 10, rows: 2 })
    t.feed("line1\r\nline2\r\nline3")
    expect(t.scrollback).toEqual(["line1"])
    expect(t.screen()).toEqual(["line2", "line3"])
  })
})

describe("FakeTerminal — CSI cursor + erase", () => {
  it("\\x1b[K erases from cursor to EOL", () => {
    const t = new FakeTerminal({ cols: 20, rows: 3 })
    t.feed("hello world\r\x1b[6C\x1b[K")
    expect(t.screen()[0]).toBe("hello")
  })

  it("\\x1b[1A moves up one row", () => {
    const t = new FakeTerminal({ cols: 20, rows: 5 })
    t.feed("line1\r\nline2\r\x1b[1A\x1b[KX")
    expect(t.screen()[0]).toBe("X")
    expect(t.screen()[1]).toBe("line2")
  })

  it("\\x1b[J erases from cursor to end of screen", () => {
    const t = new FakeTerminal({ cols: 10, rows: 4 })
    t.feed("aaaa\r\nbbbb\r\ncccc\r\nXXXX")
    // Cursor is on row 3 after the prints. \r → col 0, \x1b[1A → row 2,
    // \x1b[J → erase from row 2 col 0 forward (wipes cccc + XXXX).
    t.feed("\r\x1b[1A\x1b[J")
    expect(t.screen()).toEqual(["aaaa", "bbbb", "", ""])
  })

  it("SGR sequences are swallowed and don't move the cursor", () => {
    const t = new FakeTerminal({ cols: 20, rows: 3 })
    t.feed("\x1b[1mbold\x1b[0m text")
    expect(t.screen()[0]).toBe("bold text")
  })
})

describe("FakeTerminal — wide / zero-width", () => {
  it("CJK glyph occupies two cells", () => {
    const t = new FakeTerminal({ cols: 6, rows: 2 })
    t.feed("ab日本cd")
    // a(1) b(1) 日(2) 本(2) -> col=6 → wraps before 'cd'? actually fits: 1+1+2+2=6.
    expect(t.screen()[0]).toBe("ab日本")
    expect(t.screen()[1]).toBe("cd")
  })

  it("emoji-style codepoint counts as 2 cells", () => {
    const t = new FakeTerminal({ cols: 4, rows: 2 })
    // "🚀" = U+1F680, wide. plus "ab" → 2+1+1 = 4 fits.
    t.feed("🚀ab")
    expect(t.screen()[0]).toBe("🚀ab")
  })

  it("combining marks attach to the previous cell, no width", () => {
    const t = new FakeTerminal({ cols: 5, rows: 1 })
    t.feed("e\u0301llo") // é + llo
    expect(t.screen()[0]).toBe("e\u0301llo")
  })
})

describe("FakeTerminal — replay of compositor-style writeStream chunks", () => {
  it("erase+chunk+redraw cycle leaves the screen consistent", () => {
    const t = new FakeTerminal({ cols: 30, rows: 5 })
    // Simulated: "hello" partial, draw a 1-row live area below, erase, append " world", redraw.
    t.feed("hello") // streamCol = 5
    // drawLiveSeq: \r\n + "❯ " + \x1b[K + cursor positioning.
    t.feed("\r\n❯ \x1b[K\r\x1b[2C")
    // eraseLiveSeq: cursorRowInLive=0, streamCol=5 -> \r + \x1b[1A + \x1b[5C + \x1b[J.
    t.feed("\r\x1b[1A\x1b[5C\x1b[J")
    // Append.
    t.feed(" world")
    // drawLiveSeq again.
    t.feed("\r\n❯ \x1b[K\r\x1b[2C")
    expect(t.screen()[0]).toBe("hello world")
    expect(t.screen()[1]).toBe("❯")
  })
})

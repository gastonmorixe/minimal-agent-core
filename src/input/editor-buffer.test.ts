import { describe, expect, it } from "bun:test"

import { EditorBuffer } from "./editor-buffer.ts"

describe("EditorBuffer", () => {
  it("starts empty with cursor at 0,0", () => {
    const b = new EditorBuffer()
    expect(b.lines).toEqual([""])
    expect(b.row).toBe(0)
    expect(b.col).toBe(0)
    expect(b.toString()).toBe("")
    expect(b.isBlank()).toBe(true)
  })

  it("insert appends text and advances column", () => {
    const b = new EditorBuffer()
    b.insert("hello")
    expect(b.toString()).toBe("hello")
    expect(b.col).toBe(5)
  })

  it("newline splits the line and moves cursor to next row col 0", () => {
    const b = new EditorBuffer()
    b.insert("abcdef")
    b.col = 3
    b.newline()
    expect(b.lines).toEqual(["abc", "def"])
    expect(b.row).toBe(1)
    expect(b.col).toBe(0)
  })

  it("deleteBackward removes one char before cursor", () => {
    const b = new EditorBuffer()
    b.insert("abc")
    b.deleteBackward()
    expect(b.toString()).toBe("ab")
    expect(b.col).toBe(2)
  })

  it("deleteBackward at col 0 row > 0 joins lines", () => {
    const b = new EditorBuffer()
    b.insert("a")
    b.newline()
    b.insert("b")
    b.col = 0
    b.deleteBackward()
    expect(b.toString()).toBe("ab")
    expect(b.row).toBe(0)
    expect(b.col).toBe(1)
  })

  it("deleteForward removes char at cursor", () => {
    const b = new EditorBuffer()
    b.insert("abc")
    b.col = 1
    b.deleteForward()
    expect(b.toString()).toBe("ac")
    expect(b.col).toBe(1)
  })

  it("move left/right/up/down clamp to bounds", () => {
    const b = new EditorBuffer()
    b.insert("abc")
    b.newline()
    b.insert("de")
    b.row = 0
    b.col = 0
    expect(b.moveLeft()).toBe(false)
    b.col = 3
    expect(b.moveRight()).toBe(true)
    expect(b.row).toBe(1)
    expect(b.col).toBe(0)
    expect(b.moveDown()).toBe(false)
    expect(b.moveUp()).toBe(true)
    expect(b.row).toBe(0)
  })

  it("clear resets to empty", () => {
    const b = new EditorBuffer()
    b.insert("hi\nthere")
    b.clear()
    expect(b.lines).toEqual([""])
    expect(b.row).toBe(0)
    expect(b.col).toBe(0)
  })

  it("handles unicode (multi-codepoint) correctly", () => {
    const b = new EditorBuffer()
    b.insert("a😀b")
    expect(b.col).toBe(3)
    b.deleteBackward()
    expect(b.toString()).toBe("a😀")
    b.deleteBackward()
    expect(b.toString()).toBe("a")
  })

  it("killToLineEnd truncates current line", () => {
    const b = new EditorBuffer()
    b.insert("hello world")
    b.col = 5
    b.killToLineEnd()
    expect(b.toString()).toBe("hello")
  })

  it("killToLineStart erases left of cursor", () => {
    const b = new EditorBuffer()
    b.insert("hello world")
    b.col = 6
    b.killToLineStart()
    expect(b.toString()).toBe("world")
    expect(b.col).toBe(0)
  })

  it("deleteWordBackward removes one word", () => {
    const b = new EditorBuffer()
    b.insert("foo bar baz")
    b.col = 11
    b.deleteWordBackward()
    expect(b.toString()).toBe("foo bar ")
  })

  it("moveWordLeft / moveWordRight jump across whitespace", () => {
    const b = new EditorBuffer()
    b.insert("foo bar baz")
    b.col = 11
    b.moveWordLeft()
    expect(b.col).toBe(8)
    b.moveWordLeft()
    expect(b.col).toBe(4)
    b.moveWordRight()
    expect(b.col).toBe(7)
  })

  it("moveLineStart / moveLineEnd", () => {
    const b = new EditorBuffer()
    b.insert("hello")
    expect(b.col).toBe(5)
    b.moveLineStart()
    expect(b.col).toBe(0)
    b.moveLineEnd()
    expect(b.col).toBe(5)
  })

  it("moveWordLeft crosses line boundaries", () => {
    // ["foo bar", "baz qux"], cursor at start of "baz" (row=1, col=0).
    // Alt+B should jump to the start of "bar" on the previous line.
    const b = new EditorBuffer()
    b.insert("foo bar")
    b.newline()
    b.insert("baz qux")
    b.row = 1
    b.col = 0
    expect(b.moveWordLeft()).toBe(true)
    expect(b.row).toBe(0)
    expect(b.col).toBe(4)
    // Another Alt+B walks to the start of "foo".
    expect(b.moveWordLeft()).toBe(true)
    expect(b.row).toBe(0)
    expect(b.col).toBe(0)
    // At (0,0) there's nothing further left.
    expect(b.moveWordLeft()).toBe(false)
  })

  it("moveWordLeft hops over a blank line", () => {
    // ["abc", "", "|"] - cursor on a trailing empty line, blank line in
    // the middle. Word-left should skip both blank rows and the newlines
    // and land at the start of "abc".
    const b = new EditorBuffer()
    b.insert("abc")
    b.newline()
    b.newline()
    expect(b.row).toBe(2)
    expect(b.col).toBe(0)
    expect(b.moveWordLeft()).toBe(true)
    expect(b.row).toBe(0)
    expect(b.col).toBe(0)
  })

  it("moveWordRight crosses line boundaries", () => {
    // ["foo bar", "baz qux"], cursor at end of "foo bar" (row=0, col=7).
    // Alt+F should jump forward, treating the newline as whitespace, and
    // land at the end of "baz".
    const b = new EditorBuffer()
    b.insert("foo bar")
    b.newline()
    b.insert("baz qux")
    b.row = 0
    b.col = 7
    expect(b.moveWordRight()).toBe(true)
    expect(b.row).toBe(1)
    expect(b.col).toBe(3)
    // Another Alt+F walks to the end of "qux".
    expect(b.moveWordRight()).toBe(true)
    expect(b.row).toBe(1)
    expect(b.col).toBe(7)
    // No further movement possible.
    expect(b.moveWordRight()).toBe(false)
  })

  it("moveWordRight from start of word crosses a leading blank line", () => {
    // ["", "  abc"] - cursor at (0,0) on the empty leading row. Alt+F
    // should hop to the end of "abc".
    const b = new EditorBuffer()
    b.newline()
    b.insert("  abc")
    b.row = 0
    b.col = 0
    expect(b.moveWordRight()).toBe(true)
    expect(b.row).toBe(1)
    expect(b.col).toBe(5)
  })

  it("deleteWordBackward at col 0 joins with previous line and deletes its trailing word", () => {
    // ["foo bar", "baz"], cursor at row=1 col=0. Ctrl+W should delete
    // "bar\n" so the buffer collapses to ["foo baz"] with cursor right
    // after "foo ".
    const b = new EditorBuffer()
    b.insert("foo bar")
    b.newline()
    b.insert("baz")
    b.row = 1
    b.col = 0
    expect(b.deleteWordBackward()).toBe(true)
    expect(b.lines).toEqual(["foo baz"])
    expect(b.row).toBe(0)
    expect(b.col).toBe(4)
  })

  it("deleteWordBackward across leading whitespace joins lines correctly", () => {
    // ["foo bar", "   baz"], cursor right before "baz" (row=1, col=3).
    // Ctrl+W should eat the three spaces AND the newline AND the word
    // "bar", landing at the end of "foo ".
    const b = new EditorBuffer()
    b.insert("foo bar")
    b.newline()
    b.insert("   baz")
    b.row = 1
    b.col = 3
    expect(b.deleteWordBackward()).toBe(true)
    expect(b.lines).toEqual(["foo baz"])
    expect(b.row).toBe(0)
    expect(b.col).toBe(4)
  })

  it("deleteWordBackward at start of buffer returns false", () => {
    const b = new EditorBuffer()
    b.insert("foo")
    b.newline()
    b.insert("bar")
    b.row = 0
    b.col = 0
    expect(b.deleteWordBackward()).toBe(false)
    expect(b.lines).toEqual(["foo", "bar"])
  })
})

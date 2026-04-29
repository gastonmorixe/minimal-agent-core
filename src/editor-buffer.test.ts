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
})

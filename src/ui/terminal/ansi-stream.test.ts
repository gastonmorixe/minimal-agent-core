import { describe, expect, it } from "bun:test"

import { AnsiStreamBuffer, findEscapeSafeSplit, MAX_PENDING } from "./ansi-stream.ts"

describe("findEscapeSafeSplit", () => {
  it("plain text is fully consumable", () => {
    expect(findEscapeSafeSplit("hello world")).toBe(11)
  })

  it("complete CSI + text is fully consumable", () => {
    const s = "\x1b[1mbold\x1b[0m text"
    expect(findEscapeSafeSplit(s)).toBe(s.length)
  })

  it("trailing ESC alone is held back", () => {
    expect(findEscapeSafeSplit("hello\x1b")).toBe(5)
  })

  it("trailing ESC [ with params but no final byte is held back", () => {
    const s = "abc\x1b[38;2;180;140;255"
    expect(findEscapeSafeSplit(s)).toBe(3)
  })

  it("trailing OSC without BEL is held back", () => {
    const s = "abc\x1b]8;;https://example.com"
    expect(findEscapeSafeSplit(s)).toBe(3)
  })

  it("OSC closed with BEL is fully consumable", () => {
    const s = "\x1b]8;;u\x07link"
    expect(findEscapeSafeSplit(s)).toBe(s.length)
  })

  it("OSC closed with ST (ESC \\) is fully consumable", () => {
    const s = "\x1b]0;title\x1b\\"
    expect(findEscapeSafeSplit(s)).toBe(s.length)
  })
})

describe("AnsiStreamBuffer", () => {
  it("forwards complete chunks unchanged", () => {
    const b = new AnsiStreamBuffer()
    expect(b.push("\x1b[1mbold\x1b[0m")).toBe("\x1b[1mbold\x1b[0m")
    expect(b.pendingLength).toBe(0)
  })

  it("holds back a partial CSI and reattaches on the next chunk", () => {
    const b = new AnsiStreamBuffer()
    const out1 = b.push("hello \x1b[38;2;180;")
    expect(out1).toBe("hello ")
    expect(b.pendingLength).toBeGreaterThan(0)

    const out2 = b.push("140;255mworld")
    expect(out2).toBe("\x1b[38;2;180;140;255mworld")
    expect(b.pendingLength).toBe(0)
  })

  it("byte-by-byte feed reconstitutes the full sequence", () => {
    const b = new AnsiStreamBuffer()
    const input = "x\x1b[1mY\x1b[0mz"
    let out = ""
    for (const ch of input) out += b.push(ch)
    out += b.flush()
    expect(out).toBe(input)
  })

  it("flushes the dangling tail as-is when it exceeds MAX_PENDING", () => {
    const b = new AnsiStreamBuffer()
    // Build a long unterminated CSI that should still be released so we
    // don't stall.
    const big = "\x1b[" + "0;".repeat(MAX_PENDING + 10)
    expect(b.push(big).length).toBeGreaterThan(MAX_PENDING)
    expect(b.pendingLength).toBe(0)
  })
})

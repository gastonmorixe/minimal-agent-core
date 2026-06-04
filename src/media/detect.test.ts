import { describe, expect, it } from "bun:test"

import { looksLikeMediaDrop, parseDroppedPaths } from "./detect.ts"

describe("parseDroppedPaths", () => {
  it("reads a plain absolute path", () => {
    expect(parseDroppedPaths("/Users/x/a.png")).toEqual(["/Users/x/a.png"])
  })
  it("unescapes drag-style backslash spaces", () => {
    expect(parseDroppedPaths("/Users/x/a\\ b.png")).toEqual(["/Users/x/a b.png"])
  })
  it("reads quoted paths with spaces", () => {
    expect(parseDroppedPaths("'/Users/x/a b.png'")).toEqual(["/Users/x/a b.png"])
  })
  it("decodes file:// URLs", () => {
    expect(parseDroppedPaths("file:///Users/x/a%20b.png")).toEqual(["/Users/x/a b.png"])
  })
  it("reads several dropped paths", () => {
    expect(parseDroppedPaths("/a/x.png /a/y.jpg")).toEqual(["/a/x.png", "/a/y.jpg"])
  })
  it("ignores prose", () => {
    expect(parseDroppedPaths("hello world")).toEqual([])
  })
  it("keeps a U+202F (narrow no-break space) inside a drag-escaped path", () => {
    // macOS screenshot: ASCII spaces are backslash-escaped by Finder drag, but
    // the U+202F before "PM" is left raw. It must stay in ONE token.
    const p = "/Users/x/Screenshot\\ at\\ 5.49.35\u202fPM.png"
    expect(parseDroppedPaths(p)).toEqual(["/Users/x/Screenshot at 5.49.35\u202fPM.png"])
  })
  it("keeps a U+00A0 (no-break space) inside a path", () => {
    expect(parseDroppedPaths("/a/b\u00a0c.png")).toEqual(["/a/b\u00a0c.png"])
  })
})

describe("looksLikeMediaDrop", () => {
  it("is true for a single image path", () => {
    expect(looksLikeMediaDrop("/a/x.png")).toBe(true)
  })
  it("is true for multiple media paths", () => {
    expect(looksLikeMediaDrop("/a/x.png '/a/b c.jpg'")).toBe(true)
  })
  it("is false when prose is mixed in", () => {
    expect(looksLikeMediaDrop("look /a/x.png")).toBe(false)
  })
  it("is false for a non-media path", () => {
    expect(looksLikeMediaDrop("/a/script.sh")).toBe(false)
  })
  it("is false for plain text", () => {
    expect(looksLikeMediaDrop("just typing")).toBe(false)
  })
  it("is true for a macOS screenshot path with a U+202F before PM", () => {
    const p = "/Users/x/Screenshot\\ 2026-05-31\\ at\\ 5.49.35\u202fPM.png"
    expect(looksLikeMediaDrop(p)).toBe(true)
  })
})

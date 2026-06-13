import { describe, expect, it } from "bun:test"

import { parseJsonc, stripJsonc } from "@minimal-agent/plugin-api/utils/jsonc"

describe("jsonc", () => {
  it("parses plain JSON unchanged", () => {
    expect(parseJsonc('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" })
  })

  it("strips line comments", () => {
    const src = `{
      // model to use by default
      "model": "claude-opus-4-7", // 1m context flavor
      "effort": "high"
    }`
    expect(parseJsonc(src)).toEqual({ model: "claude-opus-4-7", effort: "high" })
  })

  it("strips block comments", () => {
    const src = `{
      /* multi-line
         block comment */
      "a": 1,
      "b": /* inline */ 2
    }`
    expect(parseJsonc(src)).toEqual({ a: 1, b: 2 })
  })

  it("preserves comment-like sequences inside strings", () => {
    const src = `{"url":"https://example.com//path","note":"a /* not a comment */ b"}`
    expect(parseJsonc(src)).toEqual({
      url: "https://example.com//path",
      note: "a /* not a comment */ b",
    })
  })

  it("respects escaped quotes in strings", () => {
    const src = `{"q":"she said \\"// hi\\" then left"}`
    expect(parseJsonc(src)).toEqual({ q: 'she said "// hi" then left' })
  })

  it("allows trailing commas in objects and arrays", () => {
    expect(parseJsonc(`{"a":1,"b":[1,2,3,],}`)).toEqual({ a: 1, b: [1, 2, 3] })
  })

  it("throws on truly invalid JSON", () => {
    expect(() => parseJsonc("{not json}")).toThrow()
  })

  it("preserves newlines so line numbers in errors are sane", () => {
    const stripped = stripJsonc(`// line 1\n{\n  "a": 1\n}\n`)
    // The `// line 1` content is gone but the newline survives
    expect(stripped.split("\n").length).toBe(5)
  })

  it("handles unterminated block comment without infinite loop", () => {
    expect(() => parseJsonc(`{"a":1 /* unterminated`)).toThrow()
  })
})

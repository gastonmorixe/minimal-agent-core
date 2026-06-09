/**
 * Tests for the comment-preserving JSONC editor.
 *
 * The defining property: edits keep the user's comments, key order, and
 * layout intact, and the output always re-parses to the expected value.
 *
 * @module config/lib/jsonc-edit.test
 */

import { describe, expect, it } from "bun:test"

import { JsoncEditError, removeKeyPath, setKeyPath } from "./jsonc-edit.ts"
import { parseJsonc } from "./mini-jsonc.ts"

describe("setKeyPath — rewrite existing", () => {
  it("rewrites a top-level scalar in place, preserving comments", () => {
    const src = `{
  // pick the 1M-context model
  "model": "claude-opus-4-8[1m]",
  "effort": "high"
}
`
    const out = setKeyPath(src, ["effort"], "low")
    expect(out).toContain("// pick the 1M-context model")
    expect(out).toContain('"effort": "low"')
    expect(parseJsonc(out)).toEqual({ model: "claude-opus-4-8[1m]", effort: "low" })
  })

  it("rewrites a boolean preserving a trailing line comment on another key", () => {
    const src = `{
  "autoAsk": true, // heuristic mode flip
  "skipQuota": false
}`
    const out = setKeyPath(src, ["skipQuota"], true)
    expect(out).toContain("// heuristic mode flip")
    expect(parseJsonc(out)).toEqual({ autoAsk: true, skipQuota: true })
  })

  it("rewrites a nested value, descending into an existing object", () => {
    const src = `{
  "plugins": {
    // fetch backend config
    "ma-fetch": {
      "enabled": true,
      "backend": "obscura"
    }
  }
}`
    const out = setKeyPath(src, ["plugins", "ma-fetch", "enabled"], false)
    expect(out).toContain("// fetch backend config")
    expect(out).toContain('"backend": "obscura"')
    expect(parseJsonc(out)).toEqual({
      plugins: { "ma-fetch": { enabled: false, backend: "obscura" } },
    })
  })

  it("replaces an object value wholesale", () => {
    const src = `{ "statusBar": { "segments": ["quota"] } }`
    const out = setKeyPath(src, ["statusBar"], { segments: ["context", "model"] })
    expect(parseJsonc(out)).toEqual({ statusBar: { segments: ["context", "model"] } })
  })
})

describe("setKeyPath — insert new", () => {
  it("inserts a new top-level key after the last member, adding a comma", () => {
    const src = `{
  "model": "claude-opus-4-8"
}`
    const out = setKeyPath(src, ["effort"], "high")
    expect(parseJsonc(out)).toEqual({ model: "claude-opus-4-8", effort: "high" })
    // existing key + comment layout untouched
    expect(out).toContain('"model": "claude-opus-4-8"')
  })

  it("inserts into an object that already has a trailing comma", () => {
    const src = `{
  "model": "x",
}`
    const out = setKeyPath(src, ["effort"], "high")
    expect(parseJsonc(out)).toEqual({ model: "x", effort: "high" })
  })

  it("inserts into an empty object, expanding it onto its own line", () => {
    const src = `{}`
    const out = setKeyPath(src, ["effort"], "high")
    expect(parseJsonc(out)).toEqual({ effort: "high" })
  })

  it("creates intermediate objects for a deep path when absent", () => {
    const src = `{
  "model": "x"
}`
    const out = setKeyPath(src, ["plugins", "config", "enabled"], true)
    expect(parseJsonc(out)).toEqual({ model: "x", plugins: { config: { enabled: true } } })
  })

  it("inserts a key into an existing nested object preserving siblings", () => {
    const src = `{
  "plugins": {
    "ma-fetch": { "enabled": true }
  }
}`
    const out = setKeyPath(src, ["plugins", "tasks"], { enabled: false })
    expect(parseJsonc(out)).toEqual({
      plugins: { "ma-fetch": { enabled: true }, tasks: { enabled: false } },
    })
  })

  it("treats a blank document as an empty object", () => {
    const out = setKeyPath("   \n", ["model"], "claude")
    expect(parseJsonc(out)).toEqual({ model: "claude" })
  })
})

describe("removeKeyPath", () => {
  it("removes a middle key and its trailing comma", () => {
    const src = `{
  "model": "x",
  "effort": "high",
  "skipQuota": true
}`
    const out = removeKeyPath(src, ["effort"])
    expect(parseJsonc(out)).toEqual({ model: "x", skipQuota: true })
    expect(out).not.toContain("effort")
  })

  it("removes the last key by dropping the preceding comma", () => {
    const src = `{
  "model": "x",
  "effort": "high"
}`
    const out = removeKeyPath(src, ["effort"])
    expect(parseJsonc(out)).toEqual({ model: "x" })
  })

  it("removes the sole key leaving an empty object", () => {
    const src = `{
  "only": 1
}`
    const out = removeKeyPath(src, ["only"])
    expect(parseJsonc(out)).toEqual({})
  })

  it("removes a nested key, preserving siblings and comments", () => {
    const src = `{
  "plugins": {
    // backend
    "ma-fetch": { "enabled": true, "backend": "obscura" }
  }
}`
    const out = removeKeyPath(src, ["plugins", "ma-fetch", "backend"])
    expect(out).toContain("// backend")
    expect(parseJsonc(out)).toEqual({ plugins: { "ma-fetch": { enabled: true } } })
  })

  it("is a no-op for an absent key", () => {
    const src = `{ "model": "x" }`
    expect(removeKeyPath(src, ["nope"])).toBe(src)
  })

  it("removes a member that has its own trailing line comment", () => {
    const src = `{
  "model": "x", // the model
  "effort": "high"
}`
    const out = removeKeyPath(src, ["model"])
    expect(parseJsonc(out)).toEqual({ effort: "high" })
    expect(out).not.toContain("the model")
  })
})

describe("error handling", () => {
  it("throws when the root is not an object", () => {
    expect(() => setKeyPath(`[1,2,3]`, ["x"], 1)).toThrow(JsoncEditError)
  })

  it("throws on an empty path", () => {
    expect(() => setKeyPath(`{}`, [], 1)).toThrow(JsoncEditError)
  })

  it("round-trips comment-heavy real config without losing notes", () => {
    const src = `{
  // Required to see plaintext thinking.
  "thinkingDisplay": "summarized",
  /* block comment */
  "formatterArgs": ["--table-fit"],
  "plugins": {
    "ma-fetch": {
      "enabled": true, // on
      "backend": "obscura"
    }
  }
}
`
    const out = setKeyPath(src, ["plugins", "ma-fetch", "enabled"], false)
    expect(out).toContain("// Required to see plaintext thinking.")
    expect(out).toContain("/* block comment */")
    expect(out).toContain("// on")
    expect(parseJsonc(out)).toEqual({
      thinkingDisplay: "summarized",
      formatterArgs: ["--table-fit"],
      plugins: { "ma-fetch": { enabled: false, backend: "obscura" } },
    })
  })
})

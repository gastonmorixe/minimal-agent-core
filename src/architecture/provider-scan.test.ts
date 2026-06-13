import { describe, expect, it } from "bun:test"

import { PROVIDER_TOKEN_RE, stripComments } from "./provider-scan.ts"

/** Run a synthetic source through the same pipeline as the repo scan. */
const codeMatches = (source: string): boolean => PROVIDER_TOKEN_RE.test(stripComments(source))

describe("PROVIDER_TOKEN_RE — established tokens", () => {
  it("matches the original fingerprints in code", () => {
    expect(codeMatches(`const url = "https://api.anthropic.com/v1/messages"`)).toBe(true)
    expect(codeMatches(`const model = "claude-sonnet-4-6"`)).toBe(true)
    expect(codeMatches(`const m = "gpt-4o"`)).toBe(true)
    expect(codeMatches(`const key = config["openai"]`)).toBe(true)
    // NOTE: \b does not fire inside camelCase or snake_case — both sides
    // of the boundary are word chars, so `registerOpenAI` / `openai_key`
    // are single words to the regex. Token-bearing STRINGS and kebab ids
    // are the scan's target; camel/snake identifiers slip by
    // (pre-existing, accepted trade-off of the word-boundary design).
    expect(codeMatches(`registerOpenAI()`)).toBe(false)
    expect(codeMatches(`const openai_key = env.KEY`)).toBe(false)
  })

  it("does not match neutral code", () => {
    expect(codeMatches(`const model = "test-model-1"`)).toBe(false)
    expect(codeMatches(`const x = resolveModel(id)`)).toBe(false)
  })

  it("exempts comments", () => {
    expect(codeMatches(`// the anthropic plugin handles this\nconst x = 1`)).toBe(false)
    expect(codeMatches(`/* see plugins/llm-anthropic */\nconst x = 1`)).toBe(false)
  })
})

describe("stripComments — edge cases", () => {
  it("preserves template literal contents including ${} expressions", () => {
    const out = stripComments("const s = `model: ${id} // not a comment`\n")
    expect(out).toContain("${id} // not a comment")
  })

  it("scans code inside ${} expressions of template literals", () => {
    // ${} expression code is left inline and still scanned.
    expect(codeMatches('const s = `x ${pick("gemini-pro")} y`\n')).toBe(true)
  })

  it("does not let an escaped quote close a string early", () => {
    // If the \" closed the string, `anthropic` would sit in code position
    // either way — so assert structure: the string survives intact.
    const out = stripComments(`const s = "a \\" b"; // anthropic comment\n`)
    expect(out).toContain(`"a \\" b"`)
    expect(out).not.toContain("anthropic")
  })

  it("does not let an escaped backslash hide a real closing quote", () => {
    const out = stripComments(`const s = "a \\\\"; // gone\nconst t = 1\n`)
    expect(out).not.toContain("gone")
    expect(out).toContain("const t = 1")
  })

  it("block comments do not nest (JS semantics: first */ closes)", () => {
    // `/* outer /* inner */` ends at the FIRST `*/`; the tail is code.
    const out = stripComments(`/* outer /* inner */ const code = 1 /* trailing */\n`)
    expect(out).toContain("const code = 1")
    expect(out).not.toContain("outer")
    expect(out).not.toContain("inner")
    expect(out).not.toContain("trailing")
  })

  it("preserves newlines inside block comments (line numbers stable)", () => {
    const out = stripComments(`/* a\nb\nc */const x = 1\n`)
    expect(out.split("\n")).toHaveLength(4)
    expect(out).toContain("const x = 1")
  })

  it("does not treat // inside a string as a comment", () => {
    const out = stripComments(`const url = "https://example.com" // real comment\n`)
    expect(out).toContain("https://example.com")
    expect(out).not.toContain("real comment")
  })

  it("does not treat /* inside a string as a comment opener", () => {
    const out = stripComments(`const s = "/* not a comment */"; const live = "gemini"\n`)
    expect(out).toContain("/* not a comment */")
    expect(out).toContain("gemini")
  })
})

describe("PROVIDER_TOKEN_RE — strengthened tokens (gemini/mistral/vertex/groq/xai/grok)", () => {
  it("matches gemini model ids in code", () => {
    expect(codeMatches(`const model = "gemini-pro"`)).toBe(true)
    expect(codeMatches(`const model = "gemini-2.0-flash"`)).toBe(true)
  })

  it("matches mistral in code", () => {
    expect(codeMatches(`const provider = "mistral"`)).toBe(true)
    expect(codeMatches(`const m = "mistral-large-latest"`)).toBe(true)
  })

  it("matches google-vertex / vertexai in code", () => {
    expect(codeMatches(`const vendor = "google-vertex"`)).toBe(true)
    expect(codeMatches(`const sdk = "vertexai"`)).toBe(true)
  })

  it("matches groq in code", () => {
    expect(codeMatches(`const host = "api.groq.com"`)).toBe(true)
  })

  it("matches xai and grok in code", () => {
    expect(codeMatches(`const provider = "xai"`)).toBe(true)
    expect(codeMatches(`const model = "grok-3"`)).toBe(true)
  })

  it("does NOT match 'grok' inside larger words (no false positive on 'grokking')", () => {
    expect(codeMatches(`const essay = "grokking deep learning"`)).toBe(false)
    expect(codeMatches(`function grokkedTheCode() {}`)).toBe(false)
  })

  it("does NOT match 'xai' inside larger words", () => {
    expect(codeMatches(`const x = "hexaint"`)).toBe(false)
  })

  it("still ignores the new tokens in comments", () => {
    expect(codeMatches(`// gemini and mistral live in their plugins\nconst x = 1`)).toBe(false)
  })
})

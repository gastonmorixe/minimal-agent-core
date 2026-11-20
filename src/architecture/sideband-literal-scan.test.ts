/**
 * Unit tests of the sideband literal scan engine: one seeded case for each
 * rule, a comment that must not count, and an allowed path.
 *
 * @module architecture/sideband-literal-scan.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import {
  compareToBaseline,
  countSidebandFindings,
  DEFAULT_SBL_ALLOW,
  isBracketNotice,
  type SblFinding,
  scanSidebandLiterals,
  scanSidebandManifest,
  scanSidebandPromptMarkdown,
  scanSidebandSource,
  totalsByRule,
} from "./sideband-literal-scan.ts"

const rules = (found: readonly SblFinding[]): string[] => found.map((f) => `${f.line}:${f.rule}`)

describe("scanSidebandSource", () => {
  it("finds a tag-literal in a string and in a template", () => {
    const src = [
      'const a = "<ma::agent::note />"',
      "const b = `</ma::emit::${kind}>`",
      'const c = "<mode-change to=\\"x\\">"',
      'const d = "<system-reminder>"',
    ].join("\n")
    expect(rules(scanSidebandSource(src, "f.ts"))).toEqual([
      "1:tag-literal",
      "2:tag-literal",
      "3:tag-literal",
      "4:tag-literal",
    ])
  })

  it("finds a tag-regex in a regex literal and in a RegExp argument", () => {
    const src = [
      "const r = /<ma::agent::ack\\s*\\/>/g",
      'const s = new RegExp("\\\\<ma::emit::")',
      "const t = x / 2 / y",
    ].join("\n")
    expect(rules(scanSidebandSource(src, "f.ts"))).toEqual(["1:tag-regex", "2:tag-regex"])
  })

  it("finds a tag-regex with an escape, a group or an encoded less-than", () => {
    const forms = [
      "/<\\/?ma::[\\w:.-]+/g",
      "/<(ma::[\\w:.-]+)>/",
      "/<(?:ma::)?mode-change\\b/",
      "/<(?:ma::(?:agent::)?)?mode-change\\b/",
      "/<(?<tag>ma::x)>/",
      "/[<]ma::x/",
      "/\\x3cma::x/",
      "/\\u003cma::x/",
      "/\\u{3c}ma::x/u",
      'new RegExp("\\\\x3cma::x")',
      'new RegExp("\\\\u003Cma::x")',
    ]
    const src = forms.map((f, k) => `const r${k} = ${f}`).join("\n")
    expect(rules(scanSidebandSource(src, "f.ts"))).toEqual(
      forms.map((_, k) => `${k + 1}:tag-regex`),
    )
  })

  it("does not count a regex with a different name after the less-than", () => {
    const src = ["const a = /<(?:div)>/", "const b = /(?<name>x)ma::/", "const c = /[<]tui::/"]
    expect(scanSidebandSource(src.join("\n"), "f.ts")).toEqual([])
  })

  it("reads a regex after the head of if, while and for", () => {
    const src = [
      "if (x) /<ma::a/.test(y)",
      "while (x) /<ma::b/.test(y)",
      "for (;;) /<ma::c/.test(y)",
      "for await (const v of w) /<ma::d/.test(v)",
      "const e = f(x) / 2 / g",
    ].join("\n")
    expect(rules(scanSidebandSource(src, "f.ts"))).toEqual([
      "1:tag-regex",
      "2:tag-regex",
      "3:tag-regex",
      "4:tag-regex",
    ])
  })

  it("known miss: a sigil built by concatenation or interpolation", () => {
    // The lexer reads one literal at a time, so it does not join parts.
    // These forms are not found. Review must catch them.
    const src = ['const a = "<ma" + "::agent::x"', "const b = `<${NS}::agent::x`"].join("\n")
    expect(scanSidebandSource(src, "f.ts")).toEqual([])
  })

  it("finds a tag-search in a member call of a search method", () => {
    const src = [
      'if (text.includes("<ma::agent::binary-result")) {}',
      'const i = s?.lastIndexOf("\\n\\n<ma::agent::policy")',
      'expect(out).toContain("<ma::agent::x")',
    ].join("\n")
    expect(rules(scanSidebandSource(src, "f.ts"))).toEqual([
      "1:tag-search",
      "2:tag-search",
      "3:tag-literal",
    ])
  })

  it("finds a bracket-notice, and skips log calls and the fixed list", () => {
    const src = [
      "const n = `\\n\\n[truncated: shown ${a} of ${b} bytes]`",
      'const p = "\\n\\n[note:"',
      'const q = "[aborted by user]"',
      'console.warn("[plugin load failed: x]")',
      'log.info("[some words here]")',
      'const r = "[DONE]"',
      'const s = "[1m]"',
      'const t = "[object Module]"',
      'const u = "[x]"',
      'const v = "[0]"',
    ].join("\n")
    expect(rules(scanSidebandSource(src, "f.ts"))).toEqual([
      "1:bracket-notice",
      "2:bracket-notice",
      "3:bracket-notice",
    ])
  })

  it("does not count a tag in a comment", () => {
    const src = [
      '// const a = "<ma::agent::note />"',
      "/* const r = /<ma::x/ */",
      "/**",
      ' * "<ma::agent::policy>" and "[note: x]"',
      " */",
      "const ok = 1",
    ].join("\n")
    expect(scanSidebandSource(src, "f.ts")).toEqual([])
  })

  it("does not count a lone less-than or a different namespace", () => {
    const src = ['const a = "a < b"', 'const b = "<div>"', 'const c = "<tui::x>"'].join("\n")
    expect(scanSidebandSource(src, "f.ts")).toEqual([])
  })

  it("reads code inside a template interpolation", () => {
    const src = 'const a = `x ${f("<ma::agent::y")} z`'
    expect(rules(scanSidebandSource(src, "f.ts"))).toEqual(["1:tag-literal"])
  })
})

describe("isBracketNotice", () => {
  it("needs a colon or two words, and a letter first", () => {
    expect(isBracketNotice("[note: x]")).toBe(true)
    expect(isBracketNotice("[timed out after ${}ms]")).toBe(true)
    expect(isBracketNotice("[x]")).toBe(false)
    expect(isBracketNotice("[0:1]")).toBe(false)
    expect(isBracketNotice("…[cut: here]")).toBe(true)
  })
})

describe("prompt-file", () => {
  it("counts a tag out of a fence in prompt markdown", () => {
    const md = ["Use <ma::emit::memory> to save.", "```", "<ma::emit::x>", "```"].join("\n")
    expect(rules(scanSidebandPromptMarkdown(md, "PROMPT.md"))).toEqual(["1:prompt-file"])
  })

  it("counts a tag in a manifest description", () => {
    const json = JSON.stringify({ tools: [{ name: "t", description: "Gives <ma::agent::x />" }] })
    expect(rules(scanSidebandManifest(json, "manifest.json"))).toEqual(["1:prompt-file"])
    expect(scanSidebandManifest("{bad", "manifest.json")).toEqual([])
  })
})

describe("scanSidebandLiterals (fixture tree)", () => {
  const root = mkdtempSync(join(tmpdir(), "sbl-scan-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  write("src/a.ts", 'export const a = "<ma::agent::a />"\n')
  write("src/a.test.ts", 'const t = "<ma::agent::a />"\n')
  write("src/ma-sideband-plugin/lib/render.ts", 'const r = "<ma::agent::r />"\n')
  write("src/__fixtures__/f.ts", 'const f = "<ma::agent::f />"\n')
  write("src/node_modules/x/i.ts", 'const n = "<ma::agent::n />"\n')
  write("src/p/prompts/x.md", "Say <ma::agent::p />\n")
  write("src/p/notes.md", "Say <ma::agent::p />\n")
  write("src/p/manifest.json", JSON.stringify({ description: "<ma::agent::m />" }))
  write("other/b.ts", 'const b = "<ma::agent::b />"\n')

  it("scans only included and not allowed files", () => {
    const found = scanSidebandLiterals({ root, include: ["src/**"], allow: DEFAULT_SBL_ALLOW })
    expect(found.map((f) => `${f.file}:${f.rule}`)).toEqual([
      "src/a.test.ts:tag-literal",
      "src/a.ts:tag-literal",
      "src/p/manifest.json:prompt-file",
      "src/p/prompts/x.md:prompt-file",
    ])
  })

  it("an allow glob removes a file", () => {
    const found = scanSidebandLiterals({ root, include: ["src/**"], allow: ["**/*.test.ts"] })
    expect(found.map((f) => f.file)).not.toContain("src/a.test.ts")
  })
})

describe("compareToBaseline", () => {
  const f = (file: string, rule: SblFinding["rule"]): SblFinding => ({
    file,
    line: 1,
    rule,
    text: "",
  })

  it("gives grown for a new count and stale for a smaller count", () => {
    const found = [f("a.ts", "tag-literal"), f("a.ts", "tag-literal"), f("b.ts", "tag-regex")]
    const out = compareToBaseline(found, {
      "a.ts": { "tag-literal": 1 },
      "c.ts": { "bracket-notice": 2 },
    })
    expect(out.grown).toEqual([
      "a.ts tag-literal: 2 (baseline 1)",
      "b.ts tag-regex: 1 (baseline 0)",
    ])
    expect(out.stale).toEqual(["c.ts bracket-notice: 0 (baseline 2)"])
  })

  it("counts and totals", () => {
    const found = [f("b.ts", "tag-search"), f("a.ts", "tag-literal"), f("a.ts", "tag-search")]
    const counts = countSidebandFindings(found)
    expect(Object.keys(counts)).toEqual(["a.ts", "b.ts"])
    expect(counts["a.ts"]).toEqual({ "tag-literal": 1, "tag-search": 1 })
    expect(totalsByRule(counts)["tag-search"]).toBe(2)
    expect(compareToBaseline(found, counts)).toEqual({ grown: [], stale: [] })
  })
})

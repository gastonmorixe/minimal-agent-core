/**
 * No prompt text in core (core-prompts-decouple step P3.6).
 *
 * Core ships no model-facing text: every prompt, tool description and
 * synthetic message lives in a plugin (ma-base-prompt-plugin,
 * ma-core-tools-plugin, ma-turn-recovery-plugin) and its style audit lives in
 * minimal-agent-plugins/tests/prompt-audit. This scanner fails when prompt
 * text or the old prompt engine comes back into core.
 *
 * Roots: `src/` and `plugin-api/src/`.
 *
 * Checks:
 * - (a) no `.md` file under a root.
 * - (b) no `PROMPTS.ts` file under a root.
 * - (c) no `.ts` file under a root names an old engine or text symbol
 *   (`FORBIDDEN_SYMBOLS`), imports a `.md` file, or uses a
 *   `with { type: "text" }` import attribute.
 * - (d) no `src/prompts` folder.
 * - (e) no non-test `.ts` file under a root sets `content:` (a tool_result
 *   or message content) to a string or template literal of 4 or more English
 *   words (P3.7). Interpolations (`${...}`) are removed before the count, so
 *   data-only content (`${a}\n\n${b}`) passes. Allowlist with a reason in
 *   `CONTENT_PROSE_ALLOWED`.
 *
 * Exclusions (all in check c, none in a, b or d):
 * - this file, because it names every forbidden symbol to search for.
 * - `TOOL_DEFINITIONS` in `*.test.ts` files only. Six tests (adapters,
 *   loops, tools) name a local `const TOOL_DEFINITIONS = buildToolDefinitions()`
 *   built from fixture providers. That is a test variable, not the deleted
 *   core export. Non-test files may not use the name.
 * - `node_modules` folders (not core source).
 *
 * Fixtures are not excluded: `__fixtures__` holds `.txt` and `.json` byte
 * fixtures, which no check reads, and a `.md` fixture is still a failure.
 *
 * @module architecture/no-prompt-text.test
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"

import { describe, expect, it } from "bun:test"

const REPO_ROOT = join(import.meta.dirname, "..", "..")
const ROOTS = ["src", "plugin-api/src"]
const SELF = "src/architecture/no-prompt-text.test.ts"

/** Symbols of the deleted prompt engine and core text exports. */
const FORBIDDEN_SYMBOLS = [
  "renderTemplate",
  "renderPrompt",
  "loadPromptText",
  "promptPath",
  "EMBEDDED_PROMPTS",
  "NEUTRAL_IDENTITY",
  "DEFAULT_INSTRUCTIONS",
  "TOOL_DEFINITIONS",
]

/** Symbols a `*.test.ts` file may use (see the module doc). */
const TEST_ALLOWED_SYMBOLS = new Set(["TOOL_DEFINITIONS"])

/** Files where (e) may find prose, each with its reason. */
const CONTENT_PROSE_ALLOWED: Readonly<Record<string, string>> = {
  "src/agent/context-compact.ts":
    "the compaction prompt, out of scope until ma-compact-plugin (design N3)",
}

/** `content:` then a string or template literal start. */
const CONTENT_RE = /\bcontent\s*:\s*(["'`])/g
const WORD_RE = /[A-Za-z]{2,}/g
const MIN_WORDS = 4

/**
 * The literal that starts at `open` (the quote index), with every
 * `${...}` interpolation removed. Nested braces and nested template
 * literals inside an interpolation are skipped.
 */
function literalAt(text: string, open: number): string {
  const quote = text[open]
  let out = ""
  let i = open + 1
  while (i < text.length) {
    const c = text[i]
    if (c === "\\") {
      i += 2
      out += " "
      continue
    }
    if (c === quote) break
    if (quote === "`" && c === "$" && text[i + 1] === "{") {
      let depth = 1
      i += 2
      while (i < text.length && depth > 0) {
        const d = text[i]
        if (d === "{") depth++
        else if (d === "}") depth--
        else if (d === "`") {
          i++
          while (i < text.length && text[i] !== "`") i += text[i] === "\\" ? 2 : 1
        }
        i++
      }
      out += " "
      continue
    }
    if (quote !== "`" && c === "\n") break
    out += c
    i++
  }
  return out
}

/**
 * Blank out block comments and whole-line `//` comments (doc examples), and
 * keep the newlines so line numbers stay right.
 */
function blankComments(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ")
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[ \t]*\/\/.*$/gm, blank)
}

/** (e) hits: `content:` set to an English prose literal. */
function contentProseHits(rel: string, source: string): string[] {
  const text = blankComments(source)
  const out: string[] = []
  for (const match of text.matchAll(CONTENT_RE)) {
    const open = match.index + match[0].length - 1
    const words = literalAt(text, open).match(WORD_RE) ?? []
    if (words.length >= MIN_WORDS) {
      out.push(`${rel}:${lineOf(text, match.index)} content prose "${words.slice(0, 6).join(" ")}"`)
    }
  }
  return out
}

function contentHits(): string[] {
  const out: string[] = []
  for (const rel of allFiles()) {
    if (!rel.endsWith(".ts") || rel.endsWith(".test.ts") || rel === SELF) continue
    if (rel.includes("/test-utils/") || Object.hasOwn(CONTENT_PROSE_ALLOWED, rel)) continue
    out.push(...contentProseHits(rel, readFileSync(join(REPO_ROOT, rel), "utf8")))
  }
  return out
}

const MD_IMPORT_RE = /\b(?:from|import)\s*\(?\s*["'][^"'\n]*\.md["']/g
const TEXT_ATTRIBUTE_RE = /\bwith\s*\{\s*type\s*:\s*["']text["']\s*\}/g

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) out.push(...walk(abs))
    else out.push(abs)
  }
  return out
}

function allFiles(): string[] {
  return ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)))
    .map((abs) => relative(REPO_ROOT, abs))
    .sort()
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length
}

function symbolHits(): string[] {
  const out: string[] = []
  const symbolRe = new RegExp(`\\b(?:${FORBIDDEN_SYMBOLS.join("|")})\\b`, "g")
  for (const rel of allFiles()) {
    if (!rel.endsWith(".ts") || rel === SELF) continue
    const isTest = rel.endsWith(".test.ts")
    const text = readFileSync(join(REPO_ROOT, rel), "utf8")
    for (const match of text.matchAll(symbolRe)) {
      if (isTest && TEST_ALLOWED_SYMBOLS.has(match[0])) continue
      out.push(`${rel}:${lineOf(text, match.index)} symbol ${match[0]}`)
    }
    for (const re of [MD_IMPORT_RE, TEXT_ATTRIBUTE_RE]) {
      for (const match of text.matchAll(re)) {
        out.push(`${rel}:${lineOf(text, match.index)} text import ${match[0]}`)
      }
    }
  }
  return out
}

describe("no prompt text in core (P3.6)", () => {
  it("scans a non-empty tree", () => {
    // Guard against a wrong root: the scan must see core source.
    expect(allFiles().filter((rel) => rel.endsWith(".ts")).length).toBeGreaterThan(100)
    expect(allFiles().some((rel) => rel.startsWith("plugin-api/src/"))).toBe(true)
  })

  it("(a) has no .md file under src or plugin-api/src", () => {
    expect(allFiles().filter((rel) => rel.endsWith(".md"))).toEqual([])
  })

  it("(b) has no PROMPTS.ts file", () => {
    expect(allFiles().filter((rel) => basename(rel) === "PROMPTS.ts")).toEqual([])
  })

  it("(c) names no prompt-engine or core-text symbol and imports no text file", () => {
    expect(symbolHits()).toEqual([])
  })

  it("(e) sets no content: to an English prose literal (P3.7)", () => {
    expect(contentHits()).toEqual([])
  })

  it("(e) catches prose and passes data (self check)", () => {
    const bad =
      "return {\n  content: `${tool} error: ${filePath} has not been read in this session.`,\n}"
    expect(contentProseHits("x.ts", bad)).toHaveLength(1)
    expect(contentProseHits("x.ts", 'x = { content: "Plugin tool canceled." }')).toHaveLength(0)
    expect(
      contentProseHits("x.ts", 'x = { content: "no tool executor is configured" }'),
    ).toHaveLength(1)
    expect(contentProseHits("x.ts", "x = { content: `${a}\\n\\n${b}` }")).toEqual([])
    expect(contentProseHits("x.ts", 'x = { content: "" }')).toEqual([])
  })

  it("(e) allowlist entries exist and carry a reason", () => {
    for (const [rel, why] of Object.entries(CONTENT_PROSE_ALLOWED)) {
      expect(existsSync(join(REPO_ROOT, rel)), rel).toBe(true)
      expect(why.length, rel).toBeGreaterThan(10)
    }
  })

  it("(d) has no src/prompts folder", () => {
    expect(existsSync(join(REPO_ROOT, "src", "prompts"))).toBe(false)
  })
})

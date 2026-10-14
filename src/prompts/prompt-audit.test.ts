import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"

import { describe, expect, test } from "bun:test"

const ROOT = resolve(import.meta.dir, "..", "..")

interface PromptFile {
  rel: string
  abs: string
  text: string
}

function walk(dir: string): string[] {
  const out: string[] = []
  // Missing root is not an error: Wave G moved every plugin (and its
  // manifest/PROMPT.md prose) to the sibling ../minimal-agent-plugins repo, so
  // the top-level ./plugins tree no longer exists in a bare core checkout. The
  // sibling repo audits its own model-facing prose in its prompt-audit test.
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    const stat = statSync(abs)
    if (stat.isDirectory()) {
      out.push(...walk(abs))
    } else if (stat.isFile()) {
      out.push(abs)
    }
  }
  return out
}

function isPromptMarkdown(rel: string): boolean {
  if (!(rel.endsWith(".md") || rel.endsWith(".tmpl.md"))) return false
  if (basename(rel) === "README.md") return false
  return (
    rel.startsWith("src/prompts/") ||
    basename(rel) === "PROMPT.md" ||
    /(^|\/)prompts\/.+\.md$/.test(rel) ||
    /(^|\/)prompts\/.+\.tmpl\.md$/.test(rel)
  )
}

function isManifestPromptSurface(rel: string): boolean {
  return rel.startsWith("plugins/") && basename(rel) === "manifest.json"
}

function modelFacingFiles(): PromptFile[] {
  return [join(ROOT, "src", "prompts"), join(ROOT, "plugins")]
    .flatMap(walk)
    .map((abs) => ({ abs, rel: relative(ROOT, abs), text: readFileSync(abs, "utf8") }))
    .filter((f) => isPromptMarkdown(f.rel) || isManifestPromptSurface(f.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel))
}

function promptMarkdownFiles(): PromptFile[] {
  return modelFacingFiles().filter((f) => isPromptMarkdown(f.rel))
}

/**
 * Blank out code fences, inline code spans, and URLs so prose rules do not
 * fire on code. Length and newlines are kept, so line numbers stay correct.
 */
function maskNonProse(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ")
  return text
    .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, blank)
    .replace(/^(?: {4,}|\t)[^\n]*$/gm, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\bhttps?:\/\/\S+/g, blank)
}

function proseFiles(): PromptFile[] {
  // modelFacingFiles() builds fresh objects per call, so in-place is safe.
  return modelFacingFiles().map((f) => Object.assign(f, { text: maskNonProse(f.text) }))
}

function isLiteralEnumValue(file: PromptFile, match: RegExpExecArray): boolean {
  return file.rel === "plugins/web-search/manifest.json" && match[0] === "ALL"
}

function lineOf(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split("\n").length
}

function violations(
  files: PromptFile[],
  pattern: RegExp,
  label: string,
  allow: (file: PromptFile, match: RegExpExecArray) => boolean = () => false,
): string[] {
  const out: string[] = []
  for (const file of files) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(file.text)) !== null) {
      if (!allow(file, match)) {
        out.push(`${file.rel}:${lineOf(file.text, match.index)} ${label}: ${match[0]}`)
      }
      if (match[0].length === 0) pattern.lastIndex++
    }
  }
  return out
}

describe("model-facing prompt audit", () => {
  test("does not reference stale tag namespaces", () => {
    const bad = violations(modelFacingFiles(), /<tui::|<ma::tui|<ma::plugin::/g, "stale namespace")
    expect(bad).toEqual([])
  })

  test("keeps prompts and tool descriptions free of typographic punctuation drift", () => {
    const bad = violations(modelFacingFiles(), /[—–→…“”‘’]/g, "typographic punctuation")
    expect(bad).toEqual([])
  })

  test("avoids shout-case prompt directives in prompts and tool descriptions", () => {
    const bad = violations(
      modelFacingFiles(),
      /\b(?:ALWAYS|NEVER|IMPORTANT|REQUIRED|SHOULD|MUST|BACKGROUND|SAME|GENERIC|DETAILED|CURRENT|CAN|OWN|LIVE|LATEST|RECORDED|ONLY|FINAL|ALL)\b|Do NOT|does NOT|is NOT|are NOT|could NOT|you are NOT|NOT its|NOT the|REFUSES/g,
      "shout-case directive",
      isLiteralEnumValue,
    )
    expect(bad).toEqual([])
  })

  // Writing-style rules (canonical spec: ma-agent-writing-style-plugin/PROMPT.md).
  test("keeps model-facing prose free of semicolons", () => {
    const bad = violations(proseFiles(), /;/g, "semicolon in prose")
    expect(bad).toEqual([])
  })

  test("keeps model-facing prose free of emoji", () => {
    const bad = violations(proseFiles(), /\p{Extended_Pictographic}/gu, "emoji")
    expect(bad).toEqual([])
  })

  test("keeps model-facing prose free of sycophancy, disclaimers, and signposting", () => {
    const bad = violations(
      proseFiles(),
      /great question|\babsolutely!|\bcertainly!|i hope this helps|let me know if you'd like|as an ai language model|let's dive in|here's what you need to know|without further ado/gi,
      "sycophancy or signposting",
    )
    expect(bad).toEqual([])
  })

  test("does not put a thematic break before a heading", () => {
    const bad = violations(
      promptMarkdownFiles(),
      /^---[ \t]*\n(?:[ \t]*\n)*#/gm,
      "--- before heading",
    )
    expect(bad).toEqual([])
  })

  test("does not reintroduce known stale prompt wording", () => {
    const bad = violations(
      modelFacingFiles(),
      /SHOULD PLAN|PHASES with TASKs|not curly `"\s*`, `"\s*`|inline <tui::memory> tag/g,
      "stale wording",
    )
    expect(bad).toEqual([])
  })

  test("does not carry avoidable whitespace in prompt markdown", () => {
    const repeatedBlankLines = violations(promptMarkdownFiles(), /\n{3,}/g, "3+ blank lines")
    const trailingWhitespace = violations(promptMarkdownFiles(), /[ \t]+$/gm, "trailing whitespace")
    expect([...repeatedBlankLines, ...trailingWhitespace]).toEqual([])
  })
})

/**
 * Sideband literal scan: the engine of the sideband guard (design
 * `research/2026-11-20-sideband-everywhere/40-design.md` section 5).
 *
 * THE RULE: only the codec plugin (`ma-sideband-plugin`) holds the wire form
 * of a sideband tag. Other code must not hold a hand-written tag literal, a
 * tag regex or a bracket notice. This engine finds them. Each gate (core,
 * plugins, CLI) gives its own root, include globs and allow globs, and keeps
 * a ratchet baseline (file to rule to count) next to the gate.
 *
 * This guard is the tracked form of the scanner rules MA010, MA011, MA012 and
 * of the `no-model-strings` rule of the core-decoupling plan.
 *
 * Detection: a small lexer removes comments and reads string, template and
 * regex literals of each `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs` or `.mts` file.
 *
 * - `tag-literal`: a string or template literal with a tag sigil: `<` or
 *   `</` then `ma:`, or a bare legacy name or a system tag name after `<`
 *   (see {@link BARE_TAG_NAMES}).
 * - `tag-regex`: a regex literal, or an argument of `RegExp(`, whose source
 *   has `ma:` after `<` (see {@link hasRegexSigil} for the escapes, groups
 *   and encoded forms of `<` that count). A regex after the `)` of an `if`,
 *   `while` or `for` head is read as a regex.
 * - `tag-search`: a `tag-literal` that is an argument of a member call of a
 *   string search method (see {@link SEARCH_METHODS}). It is counted as `tag-search`, not
 *   as `tag-literal`.
 * - `bracket-notice`: a literal that starts with `[` or `…[` (leading white
 *   space and escaped line feeds are ignored), ends with `]`, starts its
 *   content with a letter or an interpolation, and has `:` or 2 or more
 *   words. An argument of `console.*`, `log.*` or `diag.*` does not count,
 *   and the fixed list {@link BRACKET_IGNORED} does not count. A literal that
 *   is only a notice opener (`[note:`, after white space) counts too.
 * - `prompt-file`: a tag sigil out of a fenced block in a `PROMPT.md` or
 *   `prompts/**\/*.md` file, or in a `description` string of a
 *   `manifest.json` file.
 *
 * Known misses (seeded in the test): a sigil built by concatenation
 * (`"<ma" + "::"`), or by a template interpolation of the namespace
 * (`<${NS}::` in a template literal).
 *
 * Pure: it reads files and imports no core module. It is public for the
 * gates of other packages as `@minimal-agent/core/testing/sideband-literal-scan`.
 *
 * @module architecture/sideband-literal-scan
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"

/** The rule of one finding. */
export type SblRule = "tag-literal" | "tag-regex" | "tag-search" | "bracket-notice" | "prompt-file"

/** All rules, in report order. */
export const SBL_RULES: readonly SblRule[] = [
  "tag-literal",
  "tag-regex",
  "tag-search",
  "bracket-notice",
  "prompt-file",
]

/** One finding: a literal that holds a part of the wire form. */
export interface SblFinding {
  /** Root-relative path with `/` separators. */
  file: string
  /** 1-based line of the literal start. */
  line: number
  /** The rule. */
  rule: SblRule
  /** The literal source, cut to 120 characters. */
  text: string
}

/** Options of {@link scanSidebandLiterals}. */
export interface SblOptions {
  /** Absolute root directory. */
  root: string
  /** Root-relative globs of the files to scan (Bun.Glob syntax). */
  include: readonly string[]
  /** Root-relative globs of the files to skip (Bun.Glob syntax). */
  allow: readonly string[]
}

/** A ratchet baseline: file to rule to count. */
export type SblBaseline = Readonly<Record<string, Partial<Record<SblRule, number>>>>

/**
 * The allow list of the design (section 5). A gate can add more globs. The
 * engine and its test hold the patterns on purpose.
 */
export const DEFAULT_SBL_ALLOW: readonly string[] = [
  "**/ma-sideband-plugin/**",
  "**/sideband-literal-scan.ts",
  "**/sideband-literal-scan.test.ts",
  "docs/**",
  "**/docs/**",
  "research/**",
  "**/research/**",
  "**/README.md",
  "**/CHANGELOG.md",
  "README.md",
  "CHANGELOG.md",
  "**/__golden__/**",
  "**/__fixtures__/**",
  "**/goldens/**",
  "**/fixtures/**",
]

/** Directories the walk never enters. */
const SKIP_DIRS = new Set(["node_modules", ".git"])

/** File extensions the lexer reads. */
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

/** Bare legacy names and system tag names that count after `<` or `</`. */
export const BARE_TAG_NAMES: readonly string[] = [
  "mode-change",
  "memory-saved",
  "short-term-memory",
  "tui-preview",
  "system-instruction",
  "system-reminder",
]

/** String methods whose tag argument is a `tag-search`. */
export const SEARCH_METHODS: ReadonlySet<string> = new Set([
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "lastIndexOf",
  "split",
  "replace",
  "replaceAll",
  "match",
  "matchAll",
  "test",
])

/** Objects whose call arguments are log text, not model text. */
const LOG_OBJECTS: ReadonlySet<string> = new Set(["console", "log", "diag"])

/** Bracket literals that never count (exact value, or prefix with a trailing `*`). */
export const BRACKET_IGNORED: readonly string[] = [
  "[DONE]",
  "[1m]",
  "[2m]",
  "[REDACTED*",
  "[object *",
]

// The sigil is built from parts so that this file reads as one clear table.
const NS = "ma"
const TAG_SIGIL_RE = new RegExp(`<\\/?(?:${NS}:|(?:${BARE_TAG_NAMES.join("|")})\\b)`)
// After `<`: escapes, groups, `?` and `/` can come before the name.
const REGEX_SIGIL_RE = new RegExp(
  `<(?:\\\\|\\(\\?:|\\(\\?<[A-Za-z_$][\\w$]*>|\\(|\\)|\\?|\\/)*${NS}:`,
)
// An encoded `<`: `\x3c`, `\u003c`, `\u{3c}` (any count of `\`), or the class `[<]`.
const ENCODED_LT_RE = /\\+(?:x3[cC]|u003[cC]|u\{0*3[cC]\})|\[<\]/g

/** True when `text` holds a tag sigil (the `tag-literal` test). */
export function hasTagSigil(text: string): boolean {
  return TAG_SIGIL_RE.test(text)
}

/**
 * True when the regex source `text` matches a tag opener (the `tag-regex`
 * test). An encoded `<` is decoded first. Between `<` and the name, `\`,
 * `(`, `(?:`, `(?<name>`, `)`, `?` and `/` are ignored, so `<\/?ma::`,
 * `<(ma::`, `<(?:ma::)?`, `[<]ma::` and `\x3cma::` all count.
 */
export function hasRegexSigil(text: string): boolean {
  return REGEX_SIGIL_RE.test(text.replace(ENCODED_LT_RE, "<"))
}

/** One literal that the lexer found. */
interface Literal {
  kind: "string" | "template" | "regex"
  /** Source between the delimiters. A template interpolation is `${}`. */
  raw: string
  start: number
  /** The call path of the nearest open `(`, if the literal is its direct child. */
  callee?: string
}

const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
])

const NOT_CALLEES = new Set(["if", "for", "while", "switch", "catch", "function", "return"])

function isIdent(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch)
}

/** The call path before the `(` at `open`, e.g. `text.includes` or `new RegExp`. */
function calleeAt(src: string, open: number): string | undefined {
  let i = open - 1
  while (i >= 0 && /\s/.test(src[i] ?? "")) i--
  const end = i + 1
  while (i >= 0 && /[A-Za-z0-9_$.?]/.test(src[i] ?? "")) i--
  const path = src.slice(i + 1, end).replace(/\?\./g, ".")
  if (path === "" || NOT_CALLEES.has(path)) return undefined
  let j = i
  while (j >= 0 && /\s/.test(src[j] ?? "")) j--
  const isNew = src.slice(j - 2, j + 1) === "new" && !isIdent(src[j - 3])
  return isNew ? `new ${path}` : path
}

/** Keywords whose `(...)` head is followed by a statement, not a value. */
const CONTROL_HEADS = new Set(["if", "while", "for"])

/** True when the `(` at `open` starts an `if`, `while` or `for` (also `for await`) head. */
function isControlHead(src: string, open: number): boolean {
  const wordBefore = (end: number): [string, number] => {
    let i = end
    while (i >= 0 && /\s/.test(src[i] ?? "")) i--
    const e = i + 1
    while (i >= 0 && isIdent(src[i])) i--
    return [src.slice(i + 1, e), i]
  }
  const [w, i] = wordBefore(open - 1)
  if (w === "await") return wordBefore(i)[0] === "for"
  return CONTROL_HEADS.has(w)
}

/** Stack frame of an open bracket. */
interface Frame {
  ch: "(" | "[" | "{" | "${"
  callee?: string
  /** True for the head of `if`, `while` or `for`: a regex can follow its `)`. */
  head?: boolean
}

/**
 * Read the literals of one source file. Comments are skipped. Regex and
 * division are told apart by the previous token. Pure.
 */
function lexLiterals(src: string): Literal[] {
  const out: Literal[] = []
  const stack: Frame[] = []
  let i = src.startsWith("#!") ? src.indexOf("\n") : 0
  if (i < 0) return out
  // Previous significant token: "value" (an expression end) or "op".
  let prev: "value" | "op" = "op"
  const top = (): string | undefined => {
    const f = stack[stack.length - 1]
    return f?.ch === "(" ? f.callee : undefined
  }

  const readQuoted = (q: string): number => {
    let j = i + 1
    while (j < src.length && src[j] !== q && src[j] !== "\n") {
      if (src[j] === "\\") j++
      j++
    }
    out.push({ kind: "string", raw: src.slice(i + 1, j), start: i, callee: top() })
    return j + 1
  }

  const readRegex = (): number => {
    let j = i + 1
    let inClass = false
    while (j < src.length && src[j] !== "\n") {
      const c = src[j]
      if (c === "\\") {
        j += 2
        continue
      }
      if (c === "[") inClass = true
      else if (c === "]") inClass = false
      else if (c === "/" && !inClass) break
      j++
    }
    if (src[j] !== "/") return -1
    out.push({ kind: "regex", raw: src.slice(i + 1, j), start: i, callee: top() })
    j++
    while (isIdent(src[j])) j++
    return j
  }

  // A template literal. Interpolations push a "${" frame and the main loop
  // reads their code; the closing "}" resumes the template.
  const readTemplate = (from: number, start: number, parts: string[]): number => {
    let j = from
    while (j < src.length) {
      const c = src[j]
      if (c === "\\") {
        parts.push(src.slice(j, j + 2))
        j += 2
        continue
      }
      if (c === "`") {
        out.push({ kind: "template", raw: parts.join(""), start, callee: templateCallee })
        return j + 1
      }
      if (c === "$" && src[j + 1] === "{") {
        parts.push("${}")
        templates.push({ start, parts, callee: templateCallee })
        stack.push({ ch: "${" })
        return j + 2
      }
      parts.push(c ?? "")
      j++
    }
    return j
  }
  const templates: { start: number; parts: string[]; callee?: string }[] = []
  let templateCallee: string | undefined

  while (i < src.length) {
    const c = src[i] ?? ""
    const n = src[i + 1]
    if (c === "/" && n === "/") {
      const e = src.indexOf("\n", i)
      i = e < 0 ? src.length : e
      continue
    }
    if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i + 2)
      i = e < 0 ? src.length : e + 2
      continue
    }
    if (c === '"' || c === "'") {
      i = readQuoted(c)
      prev = "value"
      continue
    }
    if (c === "`") {
      templateCallee = top()
      i = readTemplate(i + 1, i, [])
      prev = "value"
      continue
    }
    if (c === "/") {
      if (prev === "op") {
        const e = readRegex()
        if (e > 0) {
          i = e
          prev = "value"
          continue
        }
      }
      i++
      prev = "op"
      continue
    }
    if (isIdent(c)) {
      let j = i
      while (isIdent(src[j])) j++
      const word = src.slice(i, j)
      prev = KEYWORDS_BEFORE_REGEX.has(word) ? "op" : "value"
      i = j
      continue
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push(
        c === "(" ? { ch: c, callee: calleeAt(src, i), head: isControlHead(src, i) } : { ch: c },
      )
      prev = "op"
      i++
      continue
    }
    if (c === ")" || c === "]" || c === "}") {
      const f = stack.pop()
      if (c === "}" && f?.ch === "${") {
        const t = templates.pop()
        if (t) {
          templateCallee = t.callee
          i = readTemplate(i + 1, t.start, t.parts)
          prev = "value"
          continue
        }
      }
      // After the `)` of an `if`, `while` or `for` head, a statement starts.
      prev = c === ")" && f?.head === true ? "op" : "value"
      i++
      continue
    }
    if (!/\s/.test(c)) prev = "op"
    i++
  }
  return out
}

/** The line starts of `text`, for {@link lineOf}. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1)
  return starts
}

/** 1-based line of `offset`. */
function lineOf(starts: readonly number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? 0) <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

const cut = (s: string): string => (s.length > 120 ? `${s.slice(0, 117)}...` : s)

/** True when the call path is `console.*`, `log.*` or `diag.*`. */
function isLogCall(callee: string | undefined): boolean {
  if (callee === undefined) return false
  const parts = callee.split(".")
  return parts.length >= 2 && LOG_OBJECTS.has(parts[parts.length - 2] ?? "")
}

/** The method name of a member call path (`a.b.includes` gives `includes`), or `""`. */
function method(callee: string | undefined): string {
  if (callee === undefined || callee.startsWith("new ")) return ""
  const parts = callee.split(".")
  return parts.length >= 2 ? (parts[parts.length - 1] ?? "") : ""
}

/** A notice opener only, for a prefix search: `[truncated:` or `[note:`. */
const NOTICE_PREFIX_RE = /^\[[a-z][a-z_-]*:$/

/** True when the literal source is a bracket notice (see the module doc). */
export function isBracketNotice(raw: string): boolean {
  const v = raw.replace(/^(?:\s|\\[nrt])+/, "").replace(/(?:\s|\\[nrt])+$/, "")
  if (NOTICE_PREFIX_RE.test(v)) return true
  const open = v.startsWith("[") || v.startsWith("…[") || v.startsWith("\\u2026[")
  if (!open || !v.endsWith("]")) return false
  if (BRACKET_IGNORED.some((x) => (x.endsWith("*") ? v.startsWith(x.slice(0, -1)) : v === x))) {
    return false
  }
  const inner = v.slice(v.indexOf("[") + 1, -1)
  if (!/^(?:[A-Za-z]|\$\{\})/.test(inner)) return false
  const words = inner.replace(/\$\{\}/g, " ").match(/[A-Za-z]{2,}/g) ?? []
  return inner.includes(":") || words.length >= 2
}

/** The rule of one literal, or `undefined`. */
function ruleOf(lit: Literal): SblRule | undefined {
  const isRegExpArg = /(?:^|\.| )RegExp$/.test(lit.callee ?? "")
  if (lit.kind === "regex" || isRegExpArg) {
    if (hasRegexSigil(lit.raw)) return "tag-regex"
    if (lit.kind === "regex") return undefined
  }
  if (hasTagSigil(lit.raw)) {
    return SEARCH_METHODS.has(method(lit.callee)) ? "tag-search" : "tag-literal"
  }
  if (!isLogCall(lit.callee) && isBracketNotice(lit.raw)) return "bracket-notice"
  return undefined
}

/**
 * Scan the source of one code file. `file` is the path to put in each
 * finding. Pure.
 */
export function scanSidebandSource(src: string, file: string): SblFinding[] {
  const starts = lineStarts(src)
  const found: SblFinding[] = []
  for (const lit of lexLiterals(src)) {
    const rule = ruleOf(lit)
    if (rule === undefined) continue
    found.push({ file, line: lineOf(starts, lit.start), rule, text: cut(lit.raw) })
  }
  return found
}

/** Scan a prompt markdown file: tag sigils out of fenced blocks. Pure. */
export function scanSidebandPromptMarkdown(text: string, file: string): SblFinding[] {
  const found: SblFinding[] = []
  let fence: string | undefined
  const lines = text.split("\n")
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k] ?? ""
    const m = /^\s*(`{3,}|~{3,})/.exec(line)
    if (m) {
      const mark = m[1] ?? ""
      if (fence === undefined) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = undefined
      continue
    }
    if (fence === undefined && hasTagSigil(line)) {
      found.push({ file, line: k + 1, rule: "prompt-file", text: cut(line.trim()) })
    }
  }
  return found
}

/** Scan the `description` strings of a `manifest.json` file. Pure. */
export function scanSidebandManifest(text: string, file: string): SblFinding[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const starts = lineStarts(text)
  const found: SblFinding[] = []
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x)
      return
    }
    if (v === null || typeof v !== "object") return
    for (const [k, x] of Object.entries(v)) {
      if (k === "description" && typeof x === "string" && hasTagSigil(x)) {
        const at = text.indexOf(JSON.stringify(x).slice(1, 21))
        found.push({
          file,
          line: lineOf(starts, Math.max(0, at)),
          rule: "prompt-file",
          text: cut(x),
        })
      } else {
        visit(x)
      }
    }
  }
  visit(data)
  return found
}

/** True when `rel` is a prompt markdown file. */
function isPromptMarkdown(rel: string): boolean {
  return basename(rel) === "PROMPT.md" || /(?:^|\/)prompts\/(?:.+\/)?[^/]+\.md$/.test(rel)
}

/** Root-relative paths of the files under `root`, `/` separators. */
function walk(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string, rel: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (SKIP_DIRS.has(name)) continue
      const abs = join(dir, name)
      const r = rel === "" ? name : `${rel}/${name}`
      let isDir = false
      try {
        isDir = statSync(abs).isDirectory()
      } catch {
        continue
      }
      if (isDir) visit(abs, r)
      else out.push(r)
    }
  }
  visit(root, "")
  return out
}

/**
 * Scan each file under `o.root` that matches an `include` glob and no
 * `allow` glob. `node_modules` and `.git` are never entered. Findings are
 * sorted by file, then line.
 */
export function scanSidebandLiterals(o: SblOptions): SblFinding[] {
  const include = o.include.map((g) => new Bun.Glob(g))
  const allow = o.allow.map((g) => new Bun.Glob(g))
  const found: SblFinding[] = []
  for (const rel of walk(o.root)) {
    if (!include.some((g) => g.match(rel))) continue
    if (allow.some((g) => g.match(rel))) continue
    let text: string
    try {
      text = readFileSync(join(o.root, rel), "utf8")
    } catch {
      continue
    }
    if (CODE_EXT.test(rel)) found.push(...scanSidebandSource(text, rel))
    else if (basename(rel) === "manifest.json") found.push(...scanSidebandManifest(text, rel))
    else if (rel.endsWith(".md") && isPromptMarkdown(rel)) {
      found.push(...scanSidebandPromptMarkdown(text, rel))
    }
  }
  return found.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
}

/** Count findings into a baseline (sorted keys, no zero entries). Pure. */
export function countSidebandFindings(found: readonly SblFinding[]): SblBaseline {
  const map = new Map<string, Map<SblRule, number>>()
  for (const f of found) {
    const m = map.get(f.file) ?? new Map<SblRule, number>()
    m.set(f.rule, (m.get(f.rule) ?? 0) + 1)
    map.set(f.file, m)
  }
  const out: Record<string, Partial<Record<SblRule, number>>> = {}
  for (const file of [...map.keys()].sort()) {
    const m = map.get(file) ?? new Map<SblRule, number>()
    const row: Partial<Record<SblRule, number>> = {}
    for (const rule of SBL_RULES) {
      const n = m.get(rule)
      if (n !== undefined) row[rule] = n
    }
    out[file] = row
  }
  return out
}

/**
 * Compare findings to a baseline. `grown`: a count above its entry (a new
 * file or rule has entry 0). `stale`: an entry above its count. Each item is
 * `"<file> <rule>: <count> (baseline <n>)"`. Pure.
 */
export function compareToBaseline(
  found: readonly SblFinding[],
  baseline: SblBaseline,
): { grown: string[]; stale: string[] } {
  const now = countSidebandFindings(found)
  const grown: string[] = []
  const stale: string[] = []
  const files = [...new Set([...Object.keys(now), ...Object.keys(baseline)])].sort()
  for (const file of files) {
    for (const rule of SBL_RULES) {
      const n = now[file]?.[rule] ?? 0
      const b = baseline[file]?.[rule] ?? 0
      const item = `${file} ${rule}: ${n} (baseline ${b})`
      if (n > b) grown.push(item)
      else if (n < b) stale.push(item)
    }
  }
  return { grown, stale }
}

/** Total count of each rule in a baseline. Pure. */
export function totalsByRule(baseline: SblBaseline): Record<SblRule, number> {
  const out = Object.fromEntries(SBL_RULES.map((r) => [r, 0])) as Record<SblRule, number>
  for (const row of Object.values(baseline)) {
    for (const rule of SBL_RULES) out[rule] += row[rule] ?? 0
  }
  return out
}

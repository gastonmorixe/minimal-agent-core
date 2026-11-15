/**
 * Pure-JS fallback for the Grep tool, used when `rg` (ripgrep) is not on
 * PATH (a slim container, a fresh box). It mirrors the ripgrep invocation
 * `execGrep` builds (`--no-heading --color=never` plus `-l` / `-c` / `-n`)
 * closely enough that the tool result has the same shape:
 *
 * - `files_with_matches`: one path per line.
 * - `count`: `path:N` per file (bare `N` when the search path is a file).
 * - `content`: `path:line:text` for matches, `path-line-text` for context
 *   lines, `--` between non-adjacent groups (no path prefix when the search
 *   path is a file).
 *
 * Directory searches print paths relative to the search root only (like
 * Glob). Single-file searches that show a path use `relativizePath` when
 * `cwd`/`home` are supplied. Files are sorted, so output is deterministic
 * (ripgrep's own order is not).
 *
 * Walk rules, matching ripgrep defaults for the common case:
 *
 * - Hidden entries (leading `.`) are skipped, and `.git` always is.
 * - Symlinks are not followed.
 * - Files with a NUL byte in their first 8 KiB are treated as binary and
 *   skipped.
 * - `.gitignore` files are honored inside a git work tree (a `.git` entry in
 *   the search root or an ancestor), including the ones in ancestors up to
 *   the repo root. `.ignore` and `.rgignore` are honored everywhere.
 *   Supported syntax: comments, blank lines, `!` negation, a trailing `/`
 *   for directories only, a leading or middle `/` to anchor, `*`, `?`,
 *   `[...]`, `**`. Not supported: the global git excludes file,
 *   `.git/info/exclude`, and escaped trailing spaces.
 * - `--glob` semantics: a pattern without `/` matches the file name, one
 *   with `/` matches the path relative to the search root, a leading `!`
 *   excludes.
 *
 * Regex dialect: JavaScript `RegExp`, not Rust `regex`. The common syntax
 * is the same. Rust-only forms (inline `(?i)`, `\z`, possessive classes)
 * fail with a Grep error, the same way a bad pattern fails in ripgrep.
 *
 * No subprocess, no shell: the model-controlled pattern and glob only ever
 * reach `RegExp` and `Bun.Glob`.
 *
 * @module tools/grep-js
 */

import { type Dirent, existsSync, readFileSync, statSync } from "node:fs"
import { open, readdir } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"

import { relativizePath } from "@minimal-agent/core/plugin-api/utils/path-compact"

/** Inputs, already normalized by `execGrep`. */
export interface JsGrepParams {
  pattern: string
  /** File or directory to search (absolute after `execGrep` resolves it). */
  searchPath: string
  outputMode: "content" | "files_with_matches" | "count"
  caseInsensitive?: boolean
  multiline?: boolean
  glob?: string
  /** Lines after each match (content mode). */
  after?: number
  /** Lines before each match (content mode). */
  before?: number
}

/** Limits and cancellation. */
export interface JsGrepOptions {
  signal?: AbortSignal
  /** Stop collecting output past this many bytes (the result is then partial). */
  maxBytes: number
  /** Wall-clock budget in ms. */
  timeoutMs: number
  /** Clock (tests). Default `Date.now`. */
  now?: () => number
  /** When set (with or without `home`), single-file display paths are relativized. */
  cwd?: string
  /** Home dir for `~/...` single-file display paths. */
  home?: string
}

/** Outcome, shaped after what the ripgrep path can observe. */
export type JsGrepOutcome =
  | { kind: "ok"; stdout: string; capped: boolean }
  | { kind: "no-match" }
  | { kind: "error"; message: string }
  | { kind: "timeout" }
  | { kind: "aborted" }

const BINARY_SNIFF_BYTES = 8192

/** One parsed ignore rule, relative to the directory of its ignore file. */
interface IgnoreRule {
  /** Directory holding the ignore file (absolute). */
  base: string
  glob: Bun.Glob
  /** Match against the basename only (pattern had no slash). */
  basenameOnly: boolean
  negate: boolean
  dirOnly: boolean
}

/** Parse one ignore file's text into rules. Pure. */
export function parseIgnoreFile(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trimEnd()
    if (line === "" || line.startsWith("#")) continue
    let negate = false
    if (line.startsWith("!")) {
      negate = true
      line = line.slice(1)
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1)
    }
    let dirOnly = false
    if (line.endsWith("/")) {
      dirOnly = true
      line = line.replace(/\/+$/, "")
    }
    if (line === "") continue
    const anchored = line.includes("/")
    if (line.startsWith("/")) line = line.slice(1)
    try {
      rules.push({
        base,
        glob: new Bun.Glob(line),
        basenameOnly: !anchored,
        negate,
        dirOnly,
      })
    } catch {
      // A malformed line is ignored, like git does.
    }
  }
  return rules
}

/** Last matching rule wins. Returns true when `abs` is ignored. Pure. */
export function isIgnored(rules: readonly IgnoreRule[], abs: string, isDir: boolean): boolean {
  let ignored = false
  const name = abs.slice(abs.lastIndexOf(sep) + 1)
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue
    let subject: string
    if (r.basenameOnly) {
      subject = name
    } else {
      const rel = relative(r.base, abs)
      if (rel.startsWith("..") || rel === "") continue
      subject = rel.split(sep).join("/")
    }
    if (r.glob.match(subject)) ignored = !r.negate
  }
  return ignored
}

/** Read and parse the ignore files that live directly in `dir`. */
function rulesInDir(dir: string, inGitRepo: boolean): IgnoreRule[] {
  const out: IgnoreRule[] = []
  const names = inGitRepo ? [".gitignore", ".ignore", ".rgignore"] : [".ignore", ".rgignore"]
  for (const n of names) {
    const p = join(dir, n)
    try {
      out.push(...parseIgnoreFile(readFileSync(p, "utf8"), dir))
    } catch {
      // absent or unreadable
    }
  }
  return out
}

/**
 * Find the git work-tree root at or above `dir`, or null. A `.git` file
 * (worktree / submodule) counts the same as a `.git` directory.
 */
function gitRootOf(dir: string): string | null {
  let cur = dir
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/** Ignore rules from ancestors of `root` up to the repo root, outermost first. */
function ancestorRules(root: string, gitRoot: string | null): IgnoreRule[] {
  if (!gitRoot || gitRoot === root) return []
  const chain: string[] = []
  let cur = dirname(root)
  for (;;) {
    chain.unshift(cur)
    if (cur === gitRoot) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return chain.flatMap((d) => rulesInDir(d, true))
}

/** Compiled `--glob` filter. */
interface GlobFilter {
  glob: Bun.Glob
  negate: boolean
  basenameOnly: boolean
}

function compileGlobFilter(raw: string | undefined): GlobFilter | null {
  if (!raw) return null
  let g = raw
  let negate = false
  if (g.startsWith("!")) {
    negate = true
    g = g.slice(1)
  }
  return { glob: new Bun.Glob(g.replace(/^\//, "")), negate, basenameOnly: !g.includes("/") }
}

function passesGlob(filter: GlobFilter | null, rel: string): boolean {
  if (!filter) return true
  const name = rel.slice(rel.lastIndexOf("/") + 1)
  const hit = filter.glob.match(filter.basenameOnly ? name : rel)
  return filter.negate ? !hit : hit
}

/** Collect candidate files under `root`, sorted, as `{ abs, rel }`. */
async function walk(
  root: string,
  filter: GlobFilter | null,
  check: () => JsGrepOutcome | null,
): Promise<{ files: Array<{ abs: string; rel: string }> } | JsGrepOutcome> {
  const gitRoot = gitRootOf(root)
  const files: Array<{ abs: string; rel: string }> = []
  const visit = async (dir: string, inherited: IgnoreRule[]): Promise<JsGrepOutcome | null> => {
    const stop = check()
    if (stop) return stop
    const rules = [...inherited, ...rulesInDir(dir, gitRoot !== null)]
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return null // unreadable dir: skip, like ripgrep (which warns on stderr)
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (e.name.startsWith(".")) continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (isIgnored(rules, abs, true)) continue
        const r = await visit(abs, rules)
        if (r) return r
      } else if (e.isFile()) {
        if (isIgnored(rules, abs, false)) continue
        const rel = relative(root, abs).split(sep).join("/")
        if (passesGlob(filter, rel)) files.push({ abs, rel })
      }
      // symlinks and special files are not followed (ripgrep default)
    }
    return null
  }
  const stop = await visit(root, ancestorRules(root, gitRoot))
  if (stop) return stop
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { files }
}

/** Read a file as text, or null when it is binary or unreadable. */
async function readText(abs: string): Promise<string | null> {
  try {
    const fh = await open(abs, "r")
    try {
      const head = Buffer.alloc(BINARY_SNIFF_BYTES)
      const { bytesRead } = await fh.read(head, 0, BINARY_SNIFF_BYTES, 0)
      if (head.subarray(0, bytesRead).includes(0)) return null
    } finally {
      await fh.close()
    }
    return await Bun.file(abs).text()
  } catch {
    return null
  }
}

/** Split text into lines the way ripgrep counts them (a final `\n` ends the last line). */
function splitLines(text: string): string[] {
  const lines = text.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** Line indexes (0-based) touched by matches. Multiline spans every line of a match. */
function matchedLines(text: string, lines: string[], re: RegExp, multiline: boolean): number[] {
  if (!multiline) {
    const out: number[] = []
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0
      if (re.test(lines[i]!)) out.push(i)
    }
    return out
  }
  // Map each match span onto line indexes through a table of line starts.
  const starts: number[] = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  const lineAt = (offset: number): number => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const hit = new Set<number>()
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const first = lineAt(m.index)
    const endOffset = Math.max(m.index, m.index + m[0].length - 1)
    const last = Math.min(lineAt(endOffset), lines.length - 1)
    for (let l = first; l <= last; l++) hit.add(l)
    if (m[0].length === 0) re.lastIndex++
  }
  return [...hit].sort((a, b) => a - b)
}

/** Render content-mode lines for one file. */
function renderContent(
  matchPrefix: string,
  contextPrefix: string,
  lines: string[],
  hits: number[],
  before: number,
  after: number,
): string[] {
  const isHit = new Set(hits)
  const show = new Set<number>()
  for (const h of hits) {
    for (let i = Math.max(0, h - before); i <= Math.min(lines.length - 1, h + after); i++) {
      show.add(i)
    }
  }
  const ordered = [...show].sort((a, b) => a - b)
  const out: string[] = []
  const withContext = before > 0 || after > 0
  let prev = -2
  for (const i of ordered) {
    if (withContext && prev >= 0 && i > prev + 1) out.push("--")
    const hit = isHit.has(i)
    out.push(`${hit ? matchPrefix : contextPrefix}${i + 1}${hit ? ":" : "-"}${lines[i]}`)
    prev = i
  }
  return out
}

/**
 * Search like `rg --no-heading --color=never` with the given mode. Never
 * throws: every failure is a {@link JsGrepOutcome}.
 */
export async function jsGrep(params: JsGrepParams, opts: JsGrepOptions): Promise<JsGrepOutcome> {
  const now = opts.now ?? Date.now
  const deadline = now() + opts.timeoutMs
  const check = (): JsGrepOutcome | null => {
    if (opts.signal?.aborted) return { kind: "aborted" }
    if (now() > deadline) return { kind: "timeout" }
    return null
  }

  let re: RegExp
  try {
    const flags = `g${params.caseInsensitive ? "i" : ""}${params.multiline ? "ms" : ""}`
    re = new RegExp(params.pattern, flags)
  } catch (e) {
    return {
      kind: "error",
      message: `regex parse error: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  let st: ReturnType<typeof statSync>
  try {
    st = statSync(params.searchPath)
  } catch {
    return {
      kind: "error",
      message: `${params.searchPath}: No such file or directory (os error 2)`,
    }
  }

  const single = st.isFile()
  let files: Array<{ abs: string; rel: string }>
  if (single) {
    files = [{ abs: params.searchPath, rel: params.searchPath }]
  } else {
    let filter: GlobFilter | null
    try {
      filter = compileGlobFilter(params.glob)
    } catch (e) {
      return {
        kind: "error",
        message: `invalid glob: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
    const walked = await walk(params.searchPath, filter, check)
    if (!("files" in walked)) return walked
    files = walked.files
  }

  const before = Math.max(0, params.before ?? 0)
  const after = Math.max(0, params.after ?? 0)
  const out: string[] = []
  let bytes = 0
  let capped = false
  let fileGroups = 0
  const push = (line: string): boolean => {
    bytes += Buffer.byteLength(line, "utf8") + 1
    if (bytes > opts.maxBytes) {
      capped = true
      return false
    }
    out.push(line)
    return true
  }

  for (const f of files) {
    const stop = check()
    if (stop) return stop
    const text = await readText(f.abs)
    if (text == null) continue
    const lines = splitLines(text)
    const hits = matchedLines(text, lines, re, params.multiline === true)
    if (hits.length === 0) continue
    const shown = single
      ? opts.cwd != null || opts.home != null
        ? relativizePath(f.abs, { cwd: opts.cwd, home: opts.home })
        : f.abs
      : f.rel
    if (params.outputMode === "files_with_matches") {
      if (!push(shown)) break
    } else if (params.outputMode === "count") {
      if (!push(single ? String(hits.length) : `${shown}:${hits.length}`)) break
    } else {
      // Matches carry `path:N:`, context lines `path-N-` (ripgrep's format).
      const rendered = renderContent(
        single ? "" : `${shown}:`,
        single ? "" : `${shown}-`,
        lines,
        hits,
        before,
        after,
      )
      if ((before > 0 || after > 0) && fileGroups > 0 && !push("--")) break
      let full = true
      for (const l of rendered) {
        if (!push(l)) {
          full = false
          break
        }
      }
      fileGroups++
      if (!full) break
    }
  }

  if (opts.signal?.aborted) return { kind: "aborted" }
  if (out.length === 0 && !capped) return { kind: "no-match" }
  return { kind: "ok", stdout: out.join("\n"), capped }
}

/**
 * Width-aware path compaction for terminal tool headers.
 *
 * A tool header such as `Read path/to/file.ts` must fit in one terminal row.
 * These helpers make a path shorter in steps, from the most readable form to
 * the shortest form, and pick the first form that fits a cell budget.
 *
 * The dir abbreviation follows the fish shell `prompt_pwd` convention: the
 * home dir becomes `~` and a dir component becomes its first character
 * (https://fishshell.com/docs/current/cmds/prompt_pwd.html). This module
 * keeps the first and the last dir component full, so the project root and
 * the parent dir stay readable.
 *
 * All functions are pure: no fs and no process access. The caller passes
 * `cwd` and `home`. Paths use POSIX `/` separators. Windows `\` separators
 * are not supported: such a path is treated as one component.
 *
 * Widths are terminal cells from {@link displayWidth}, so CJK and emoji
 * count as 2 cells. The ellipsis is the single-cell `…` (U+2026).
 *
 * @module path-compact
 */

import { displayWidth, truncateDisplayWidth } from "./term-width.ts"

/** Single-cell ellipsis used by every elided form. */
const ELLIPSIS = "\u2026"

/** Options for {@link formatPathCompact}. */
export interface PathCompactOptions {
  /** Current working dir. A path inside it becomes relative. */
  cwd?: string
  /** Home dir. A path inside it (and outside `cwd`) becomes `~/...`. */
  home?: string
  /** Max display cells. `undefined` or `Infinity` means no width limit. */
  budget?: number
}

/** Remove trailing `/` characters, but keep the root `/`. */
function stripTrailingSlashes(p: string): string {
  let end = p.length
  while (end > 1 && p.charCodeAt(end - 1) === 0x2f) end -= 1
  return p.slice(0, end)
}

/**
 * Return the part of `path` below `base`, or `undefined` when `path` is not
 * inside `base`. The match is on a segment boundary: `/a/bc` is not inside
 * `/a/b`. `path === base` returns `""`.
 */
function insideRest(path: string, base: string): string | undefined {
  if (path === base) return ""
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1)
  return undefined
}

/**
 * Make an absolute path relative to `cwd`, or to `home` as `~/...`.
 *
 * A path inside `cwd` loses the `cwd` prefix (no `./`), and `path === cwd`
 * gives `.`. Else a path inside `home` gives `~/...`, and `path === home`
 * gives `~`. Else the path is returned unchanged. A relative input path is
 * returned unchanged.
 */
export function relativizePath(path: string, opts: { cwd?: string; home?: string }): string {
  if (!path.startsWith("/")) return path
  const collapsed = collapseSlashes(path)
  const p = stripTrailingSlashes(collapsed)
  // A root `/` base would make every absolute path relative, so it is skipped.
  const cwd = normalizeBase(opts.cwd)
  if (cwd !== undefined) {
    const rest = insideRest(p, cwd)
    if (rest !== undefined) return rest === "" ? "." : rest
  }
  const home = normalizeBase(opts.home)
  if (home !== undefined) {
    const rest = insideRest(p, home)
    if (rest !== undefined) return rest === "" ? "~" : `~/${rest}`
  }
  return collapsed
}

/** Replace each run of `/` with one `/`. */
function collapseSlashes(p: string): string {
  return p.replace(/\/{2,}/g, "/")
}

/** An absolute, collapsed base dir without trailing `/`, or `undefined` for none or `/`. */
function normalizeBase(base: string | undefined): string | undefined {
  if (!base?.startsWith("/")) return undefined
  const b = stripTrailingSlashes(collapseSlashes(base))
  return b === "/" ? undefined : b
}

/** Shorten one dir component: 1 code point, or 2 for a dotfile. */
function abbreviate(component: string): string {
  const chars = Array.from(component)
  const keep = chars[0] === "." ? 2 : 1
  return chars.slice(0, keep).join("")
}

/** Parsed path: optional root token (`""` for `/`, or `~`), dirs, basename. */
interface PathParts {
  root: string | undefined
  dirs: string[]
  base: string
}

/** Split a relativized path into a root token, dir components, and a basename. */
function parsePath(p: string): PathParts {
  const raw = p.split("/")
  let root: string | undefined
  if (raw[0] === "" || raw[0] === "~") root = raw.shift()
  const parts = raw.filter((s) => s !== "")
  const base = parts.pop() ?? ""
  return { root, dirs: parts, base }
}

/** Join a root token, components, and a basename back into a path. */
function joinPath(root: string | undefined, comps: string[]): string {
  const body = comps.join("/")
  if (root === undefined) return body
  return `${root}/${body}`
}

/**
 * Return compact forms of `path`, from the longest to the shortest.
 *
 * The steps are: the relativized path, fish-style abbreviated dirs (first and
 * last dir kept full), `head/…/parent/base`, `…/parent/base`, and `base`.
 * A step that does not make the form strictly narrower is skipped, so the
 * list has no duplicates and the widths decrease.
 */
export function pathCompactVariants(path: string, opts: { cwd?: string; home?: string } = {}): string[] {
  const rel = relativizePath(path, opts)
  const out: string[] = [rel]
  let lastWidth = displayWidth(rel)
  const push = (v: string): void => {
    const w = displayWidth(v)
    if (v === "" || w >= lastWidth) return
    out.push(v)
    lastWidth = w
  }

  const { root, dirs, base } = parsePath(rel)
  if (base === "" || (dirs.length === 0 && root === undefined)) return out

  if (dirs.length > 2) {
    const mid = dirs.slice(1, -1).map(abbreviate)
    push(joinPath(root, [dirs[0], ...mid, dirs[dirs.length - 1], base]))
  }
  if (dirs.length >= 2) {
    push(joinPath(root, [dirs[0], ELLIPSIS, dirs[dirs.length - 1], base]))
  }
  if (dirs.length >= 1) {
    push(`${ELLIPSIS}/${dirs[dirs.length - 1]}/${base}`)
  }
  push(base)
  return out
}

/** Longest prefix of `s` that fits in `width` cells (no suffix). */
function takeHead(s: string, width: number): string {
  if (width <= 0) return ""
  return truncateDisplayWidth(s, width, "")
}

/** Longest suffix of `s` that fits in `width` cells. */
function takeTail(s: string, width: number): string {
  if (width <= 0) return ""
  const chars = Array.from(s)
  let used = 0
  let start = chars.length
  while (start > 0) {
    const w = displayWidth(chars[start - 1])
    if (used + w > width) break
    used += w
    start -= 1
  }
  return chars.slice(start).join("")
}

/** Middle-elide `s` to at most `budget` cells with one `…`. */
function middleElide(s: string, budget: number): string {
  if (budget <= 0) return ""
  if (displayWidth(s) <= budget) return s
  const avail = budget - 1
  const headWidth = Math.ceil((avail * 2) / 3)
  const head = takeHead(s, headWidth)
  const tail = takeTail(s, avail - displayWidth(head))
  return `${head}${ELLIPSIS}${tail}`
}

/**
 * Extension candidates of a basename, longest first. A short inner segment
 * joins the last one, so `name.test.ts` gives `.test.ts` then `.ts`. A
 * leading dot (a dotfile) is not an extension.
 */
function extensionCandidates(name: string): string[] {
  const last = name.lastIndexOf(".")
  if (last <= 0 || last === name.length - 1) return []
  const out: string[] = []
  const prev = name.lastIndexOf(".", last - 1)
  if (prev > 0 && last - prev <= 8) out.push(name.slice(prev))
  out.push(name.slice(last))
  return out
}

/** Elide the stem of `name` to fit `budget`, and keep the extension when it fits. */
function elideBasename(name: string, budget: number): string {
  for (const ext of extensionCandidates(name)) {
    const extWidth = displayWidth(ext)
    const stem = name.slice(0, name.length - ext.length)
    // Keep at least 1 stem cell plus the ellipsis.
    if (extWidth + 2 > budget) continue
    return `${middleElide(stem, budget - extWidth)}${ext}`
  }
  return middleElide(name, budget)
}

/**
 * Format `path` to fit `opts.budget` display cells.
 *
 * Returns the first form from {@link pathCompactVariants} that fits. When even
 * the basename overflows, the basename is middle-elided with `…` and keeps its
 * extension when there is room (`very-long-na…me.test.ts`). The result is never
 * wider than the budget when the budget is 1 or more. A budget below 1 gives
 * `""`. No budget gives the relativized path.
 */
export function formatPathCompact(path: string, opts: PathCompactOptions = {}): string {
  const variants = pathCompactVariants(path, opts)
  const budget = opts.budget
  if (budget === undefined || !Number.isFinite(budget)) return variants[0]
  const cells = Math.floor(budget)
  if (cells < 1) return ""
  for (const v of variants) {
    if (displayWidth(v) <= cells) return v
  }
  const shortest = variants[variants.length - 1]
  const { base } = parsePath(shortest)
  return elideBasename(base === "" ? shortest : base, cells)
}

/**
 * Split a path into its dir part and its basename, for dim-dir and
 * bright-basename styling. The dir part keeps its trailing `/`, so
 * `dir + base === path`.
 */
export function splitPathForStyle(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/")
  if (i < 0) return { dir: "", base: path }
  return { dir: path.slice(0, i + 1), base: path.slice(i + 1) }
}

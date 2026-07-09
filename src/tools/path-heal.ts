/**
 * Whitespace-confusable path healing for file tools.
 *
 * macOS names screenshots with a NARROW NO-BREAK SPACE (U+202F) before
 * "AM"/"PM". Such Unicode whitespace is easily normalized to a regular space
 * somewhere between the model emitting a tool call and `readFileSync` running,
 * which then looks up bytes that do not exist on disk and fails with ENOENT.
 * These helpers heal that mismatch by folding both the requested name and the
 * real directory entries to the same whitespace class before matching.
 *
 * @module tools/path-heal
 */

import { existsSync, readdirSync } from "node:fs"
import { basename, dirname } from "node:path"

/**
 * Fold every run of Unicode whitespace to a single ASCII space.
 *
 * macOS names screenshots with a NARROW NO-BREAK SPACE (U+202F) before
 * "AM"/"PM" (e.g. `Screenshot 2026-05-31 at 5.49.35␏PM.png`). When that name
 * is typed, dragged, or copied into a tool call it is easy for the literal
 * U+202F to be normalized to a regular space (U+0020) somewhere along the way,
 * so `readFileSync` then looks up bytes that do not exist on disk → ENOENT.
 * Folding both the requested name and the real directory entries to the same
 * whitespace class lets us match across that confusable. NBSP (U+00A0), the
 * en/em spaces (U+2000–U+200A), the ideographic space (U+3000), and tabs are
 * folded too, so the heal is general, not AM/PM-specific.
 */
export function foldWhitespace(s: string): string {
  return s.replace(/\s+/g, " ")
}

/**
 * Resolve a path that may differ from the on-disk name only by a
 * whitespace-confusable (see {@link foldWhitespace}). Returns the requested
 * path unchanged when it exists; otherwise scans the parent directory for the
 * single entry whose whitespace-folded name matches, and returns that real
 * path. Returns `null` when there is no match or the match is ambiguous (more
 * than one entry folds to the same name), so the caller surfaces the original
 * ENOENT rather than guessing.
 */
export function resolveWhitespaceConfusablePath(filePath: string): string | null {
  // Guard non-string / empty input: let the executor's own validation speak.
  if (typeof filePath !== "string" || filePath.length === 0) return null
  if (existsSync(filePath)) return filePath
  let entries: string[]
  const dir = dirname(filePath)
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  const wantBase = foldWhitespace(basename(filePath))
  const matches = entries.filter((e) => foldWhitespace(e) === wantBase)
  if (matches.length !== 1) return null
  const healed = `${dir}/${matches[0]}`
  return existsSync(healed) ? healed : null
}

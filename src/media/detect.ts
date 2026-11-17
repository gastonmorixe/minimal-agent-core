/**
 * Detect file paths in a pasted/dropped terminal chunk.
 *
 * Drag-and-drop in a terminal arrives as TEXT on the bracketed-paste channel:
 * the dropped file's path, often shell-escaped (`/a/b\ c.png`), quoted, or a
 * `file://` URL. This module turns such a chunk into candidate absolute paths.
 * It does NO filesystem I/O : the caller decides which candidates actually
 * exist and carry a media mime before intercepting the paste.
 *
 * @module media/detect
 */

import { isTypedMediaPath } from "./probe.ts"

/**
 * Split a pasted chunk into tokens, respecting quotes + backslash escapes.
 *
 * The unquoted-token class splits on ASCII whitespace only (space, tab, CR,
 * LF, FF, VT) — NOT on the Unicode spaces that legitimately appear *inside* a
 * path. macOS names screenshots with a NARROW NO-BREAK SPACE (U+202F) before
 * "AM"/"PM" and the Finder drag escapes ASCII spaces with a backslash but
 * leaves U+202F (and U+00A0) raw. Splitting on `\s` there would shatter one
 * dropped path into several non-path tokens, so `looksLikeMediaDrop` would
 * reject the drop and the editor would insert the raw path as literal text.
 */
function tokenize(text: string): string[] {
  const t = text.trim()
  if (!t) return []
  const out: string[] = []
  // `[^ \t\r\n\f\v\\]` instead of `[^\s\\]`: keep Unicode spaces in the token.
  const re = /'([^']*)'|"([^"]*)"|((?:\\.|[^ \t\r\n\f\v\\])+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t)) !== null) {
    let tok = m[1] ?? m[2] ?? m[3] ?? ""
    if (m[3] !== undefined) tok = tok.replace(/\\(.)/g, "$1") // unescape `\ ` etc.
    if (tok.startsWith("file://")) {
      try {
        tok = decodeURIComponent(new URL(tok).pathname)
      } catch {
        // leave as-is
      }
    }
    out.push(tok)
  }
  return out
}

const isAbsPath = (p: string): boolean => p.startsWith("/") || p.startsWith("~/")

/**
 * Extract candidate absolute paths from a pasted chunk. Handles single/double
 * quotes, backslash-escaped spaces (the macOS/iTerm drag format), and
 * `file://` URLs. Returns only entries that look like absolute paths.
 */
export function parseDroppedPaths(text: string): string[] {
  return tokenize(text).filter(isAbsPath)
}

/**
 * Does this pasted chunk look like ONLY droppable media paths (so the editor
 * should intercept it rather than insert literal text)? Requires EVERY token to
 * be an absolute path with an extension the media registry can type (images,
 * PDF, audio, video, Office, text, code; see `isTypedMediaPath`) : a single
 * prose word makes it a normal paste. The caller still verifies existence,
 * types the file, and gates it on the active model before registering.
 */
export function looksLikeMediaDrop(text: string): boolean {
  const tokens = tokenize(text)
  if (tokens.length === 0) return false
  return tokens.every((tok) => isAbsPath(tok) && isTypedMediaPath(tok))
}

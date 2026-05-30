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

const IMAGE_DOC_EXT = /\.(jpe?g|png|gif|webp|pdf|txt)$/i

/** Split a pasted chunk into tokens, respecting quotes + backslash escapes. */
function tokenize(text: string): string[] {
  const t = text.trim()
  if (!t) return []
  const out: string[] = []
  const re = /'([^']*)'|"([^"]*)"|((?:\\.|[^\s\\])+)/g
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
 * be an absolute path with a media-ish extension : a single prose word makes it
 * a normal paste. The caller still verifies existence + sniffs the real mime
 * before registering.
 */
export function looksLikeMediaDrop(text: string): boolean {
  const tokens = tokenize(text)
  if (tokens.length === 0) return false
  return tokens.every((tok) => isAbsPath(tok) && IMAGE_DOC_EXT.test(tok))
}

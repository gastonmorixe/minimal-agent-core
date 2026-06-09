/**
 * Synchronous paste interceptor for the editor.
 *
 * Wired into {@link EditorController} as `pasteInterceptor`. Called with the
 * raw bracketed-paste text; returns a replacement string (media tokens) to
 * insert instead, or `null` to fall through to normal literal paste.
 *
 * Two cases:
 * - **Drag-and-drop**: the paste is one or more media file paths
 *   ({@link looksLikeMediaDrop}). Register each existing file and return the
 *   joined `[Image #id …]` tokens.
 * - **Clipboard image**: the paste is empty/blank but the system clipboard
 *   holds an image (terminals deliver no text for an image paste). Capture it
 *   via {@link clipboardImageSync} and return a single token.
 *
 * Everything here is synchronous (the editor FSM is) : it uses the registry's
 * sync registration + a sync clipboard subprocess. Unreadable / oversize media
 * is reported via `diag.warn` and falls through (returns `null`) so the user
 * still sees their literal paste rather than nothing.
 *
 * @module media/paste-intercept
 */

import { existsSync } from "node:fs"

import { diag } from "../diagnostic-bus.ts"

import { clipboardImageSync } from "./clipboard.ts"
import { defaultMediaLimits } from "./default-limits.ts"
import { looksLikeMediaDrop, parseDroppedPaths } from "./detect.ts"
import { DEFAULT_VISION_MODALITIES } from "./ingest.ts"
import { checkMedia } from "./limits.ts"
import type { MediaRegistry } from "./registry.ts"
import { getSessionMediaRegistry } from "./session-registry.ts"
import { formatMediaToken } from "./token.ts"

// Attach-time screen uses the neutral conservative floor: paste happens
// before a model is necessarily resolved, and the submit path re-validates
// against the ACTIVE model's provider limits anyway.
const LIMITS = defaultMediaLimits()

/** Validate an item at attach-time; warn + return false when it must be dropped. */
function acceptOrWarn(item: {
  kind: "image" | "audio" | "video" | "document"
  mimeType: string
  sizeBytes: number
  dimensions: { width: number; height: number } | null
  id: string
}): boolean {
  const v = checkMedia(item, LIMITS, DEFAULT_VISION_MODALITIES)
  if (v.ok) return true
  diag.warn("media.rejected", v.message, { id: item.id, code: v.code })
  return false
}

/**
 * Try to turn a paste into media token(s). Returns the replacement text, or
 * `null` to insert the paste literally.
 */
export function mediaPasteInterceptor(
  pasted: string,
  registry: MediaRegistry = getSessionMediaRegistry(),
): string | null {
  // Case 1: drag-and-drop of media file path(s).
  if (looksLikeMediaDrop(pasted)) {
    const paths = parseDroppedPaths(pasted).filter(existsSync)
    if (paths.length === 0) return null
    const tokens: string[] = []
    for (const p of paths) {
      try {
        const item = registry.registerFileSync(p, "drop")
        if (acceptOrWarn(item)) tokens.push(formatMediaToken(item))
      } catch {
        return null // unreadable -> literal paste
      }
    }
    return tokens.length > 0 ? tokens.join(" ") : null
  }

  // Case 2: empty/blank paste + an image on the clipboard.
  if (pasted.trim() === "") {
    const bytes = clipboardImageSync()
    if (!bytes) return null
    const item = registry.registerBytesSync(bytes, "clipboard", "image/png")
    if (!acceptOrWarn(item)) return null
    return formatMediaToken(item)
  }

  return null
}

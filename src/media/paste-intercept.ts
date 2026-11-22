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
 * is reported as a warning diagnostic and falls through (returns `null`) so the user
 * still sees their literal paste rather than nothing.
 *
 * @module media/paste-intercept
 */

import { existsSync } from "node:fs"

import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import { type Diagnostics, processDiagnostics } from "../diagnostics/hub.ts"

import { clipboardImageSync } from "./clipboard.ts"
import { defaultMediaLimits } from "./default-limits.ts"
import { looksLikeMediaDrop, parseDroppedPaths } from "./detect.ts"
import { checkMedia } from "./limits.ts"
import type { MediaRegistry } from "./registry.ts"
import { getSessionMediaRegistry } from "./session-registry.ts"
import { formatMediaToken } from "./token.ts"
import { type ModelMediaContext, resolveModelMediaContext } from "./tool-context.ts"

/** Every modality on: the no-model attach screen checks only sizes. */
const ALL_MODALITIES = { image: true, audio: true, pdf: true, video: true }

/** Validate an item at attach-time; warn + return false when it must be dropped. */
export function acceptOrWarn(
  item: {
    kind: "image" | "audio" | "video" | "document"
    mimeType: string
    sizeBytes: number
    dimensions: { width: number; height: number } | null
    id: string
  },
  diagnostics: Diagnostics,
  text: SyntheticTextResolver | undefined,
  model: ModelMediaContext | undefined,
): boolean {
  // With the active model: the same gate as the tool and submit paths. With no
  // model: only the neutral size floor (the type is gated at submit, when the
  // model is known), so an audio or text drop is not refused before then.
  const v = model
    ? checkMedia(item, model.limits, model.modalities, model.modelId, text)
    : checkMedia(
        item,
        { ...defaultMediaLimits(), acceptedMimeTypes: new Set([item.mimeType.toLowerCase()]) },
        ALL_MODALITIES,
        undefined,
        text,
      )
  if (v.ok) return true
  diagnostics.warn("media.rejected", v.message, { id: item.id, code: v.code })
  return false
}

/**
 * Try to turn a paste into media token(s). Returns the replacement text, or
 * `null` to insert the paste literally. A rejected item is reported on
 * `diagnostics` (S20). Default: the process bus, no session id. `text` is the
 * core's synthetic text resolver for the rejection message
 * (`user_media.rejected`, the same text the model marker uses). Omitted: "" (no
 * provider). `modelId` is the active model: when it resolves, the paste is
 * gated on its provider limits and accepted MIME types (as the tool and submit
 * paths are). Omitted: only the size floor applies; submit gates the type.
 */
export function mediaPasteInterceptor(
  pasted: string,
  registry: MediaRegistry = getSessionMediaRegistry(),
  diagnostics: Diagnostics = processDiagnostics(),
  text?: SyntheticTextResolver,
  modelId?: string,
): string | null {
  const model = resolveModelMediaContext(modelId)
  // Case 1: drag-and-drop of media file path(s).
  if (looksLikeMediaDrop(pasted)) {
    const paths = parseDroppedPaths(pasted).filter(existsSync)
    if (paths.length === 0) return null
    const tokens: string[] = []
    for (const p of paths) {
      try {
        const item = registry.registerFileSync(p, "drop")
        if (acceptOrWarn(item, diagnostics, text, model)) tokens.push(formatMediaToken(item))
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
    if (!acceptOrWarn(item, diagnostics, text, model)) return null
    return formatMediaToken(item)
  }

  return null
}

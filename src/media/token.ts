/**
 * The inline media token grammar: `[Image #a1b2c3d4 1466x1954 461KB]`.
 *
 * The token is plain text the user can move, cut, paste, or delete like any
 * other text in the prompt. Only the **kind word** and the **8-hex id** are
 * load-bearing; the trailing descriptor (`1466x1954 461KB`) is cosmetic and may
 * drift. At submit (and cheaply on edits) we parse tokens back to ids to learn
 * which registry items the turn references.
 *
 * @module media/token
 */

import { kindToken, type MediaItem, type MediaKind, mediaDescriptor } from "./types.ts"

/** Match `[Image #id …]` / `[Audio …]` / `[Video …]` / `[File …]`. `id` = 8 hex. */
export const MEDIA_TOKEN_RE = /\[(Image|Audio|Video|File) #([0-9a-f]{8})\b[^\]]*\]/g

const WORD_TO_KIND: Record<string, MediaKind> = {
  Image: "image",
  Audio: "audio",
  Video: "video",
  File: "document",
}

/** One parsed token occurrence in some text. */
export interface MediaTokenRef {
  kind: MediaKind
  id: string
  /** Inclusive start index in the source string. */
  start: number
  /** Exclusive end index in the source string. */
  end: number
  /** The exact matched substring. */
  raw: string
}

/** Render the canonical token for an item: `[Image #a1b2c3d4 1466x1954 461KB]`. */
export function formatMediaToken(item: MediaItem): string {
  const desc = mediaDescriptor(item)
  return `[${kindToken(item.kind)} #${item.id}${desc ? ` ${desc}` : ""}]`
}

/**
 * Find every media token in `text`, in document order. Duplicate ids are
 * returned once per occurrence (the caller dedupes if it wants one block per id).
 */
export function parseMediaTokens(text: string): MediaTokenRef[] {
  const out: MediaTokenRef[] = []
  // Fresh regex state per call (the module-level RE is /g and stateful).
  const re = new RegExp(MEDIA_TOKEN_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const kind = WORD_TO_KIND[m[1]!]
    if (!kind) continue
    out.push({ kind, id: m[2]!, start: m.index, end: m.index + m[0].length, raw: m[0] })
  }
  return out
}

/**
 * Remove media tokens from `text` (the text that becomes the user's `text`
 * block; the bytes ride as real content blocks instead). Collapses the
 * whitespace a removed token leaves behind so `"look [Image #…] here"` becomes
 * `"look here"`, not `"look  here"`.
 */
export function stripMediaTokens(text: string): string {
  return text
    .replace(MEDIA_TOKEN_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .trim()
}

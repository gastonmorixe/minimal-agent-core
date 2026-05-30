/**
 * Provider-neutral media descriptors for multimodal ingestion.
 *
 * A {@link MediaItem} is the raw, opinion-free truth about one piece of media
 * the user attached (a dropped path, a pasted screenshot, a tool output). It
 * carries bytes (lazily) plus probed metadata, and nothing provider-specific.
 * Each provider adapter turns an item into wire content at send time via the
 * canonical {@link ImageSource} / {@link AudioSource} / {@link FileSource}
 * trichotomy already defined in {@link module:llm/canonical-messages}.
 *
 * Design: `private/multimodality-ingestion/design/20-design-spec.md`.
 *
 * @module media/types
 */

import type { AudioSource, FileSource, ImageSource } from "../llm/canonical-messages.ts"

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Coarse media class. Drives the token glyph, the capability gate
 * (`Capabilities.modalities`), and which canonical block an item becomes.
 * `document` covers PDFs and plain-text files (Anthropic `document` block).
 */
export type MediaKind = "image" | "audio" | "video" | "document"

/** Where the user got the media from. Affects heuristics + the token glyph. */
export type MediaOrigin = "drop" | "clipboard" | "path" | "url" | "tool"

/**
 * Lifecycle state. See the state machine in the design spec §4.
 *
 * - `registered`: known to the registry; bytes may be unloaded.
 * - `validated`: passed limit + modality checks for the *current* model.
 * - `rejected`: failed a check; `rejection` is set, item is NOT attached.
 * - `preparing`: an async prepare/upload is in flight.
 * - `ready`: prepared; `prepared[providerId]` holds the embeddable source.
 * - `failed`: prepare/upload errored.
 */
export type MediaState = "registered" | "validated" | "rejected" | "preparing" | "ready" | "failed"

/** Why an item was rejected. Stable codes so callers can branch / localize. */
export type MediaRejectionCode =
  | "unsupported-type"
  | "unsupported-modality"
  | "too-large"
  | "request-too-large"
  | "too-many"
  | "dimensions"

/** A rejection verdict payload. `message` is user-facing (shown in the warning). */
export interface MediaRejection {
  code: MediaRejectionCode
  message: string
}

// ---------------------------------------------------------------------------
// Prepared (per-provider) handle
// ---------------------------------------------------------------------------

/**
 * The result of a provider preparing an item: the canonical source to embed
 * plus the byte count actually sent (post-future-compression). Cached on
 * `MediaItem.prepared[providerId]` so re-preparing the same item for the same
 * provider is a no-op and providers never clobber each other.
 */
export interface PreparedMedia {
  source: ImageSource | AudioSource | FileSource
  bytesSent: number
}

// ---------------------------------------------------------------------------
// MediaItem
// ---------------------------------------------------------------------------

/**
 * One attached piece of media. Bytes load lazily (`bytes()`): a dropped 40MB
 * video should not sit in RAM until it is actually referenced at submit.
 */
export interface MediaItem {
  /** 8-hex short id, content-addressed by sha256(bytes) when bytes are known. */
  id: string
  kind: MediaKind
  /** Canonical mime sniffed from magic bytes (NOT the file extension). */
  mimeType: string
  origin: MediaOrigin
  /** Absolute path for `drop`/`path` origins; `null` for pasted bytes. */
  path: string | null
  /** Byte length of the underlying media. */
  sizeBytes: number
  /** sha256 hex of the bytes: content address + dedupe key. */
  sha256: string
  /** Pixel dimensions when probed (image/video); `null` otherwise. */
  dimensions: { width: number; height: number } | null
  /** Duration in seconds for audio/video when probed; `null` otherwise. */
  durationSec: number | null
  state: MediaState
  /** Set iff `state === "rejected"`. */
  rejection?: MediaRejection
  /** Lazily read the bytes (from `path` or an in-memory/spilled buffer). */
  bytes(): Promise<Uint8Array>
  /** Per-provider prepared handles, keyed by `providerId`. */
  prepared: Record<string, PreparedMedia>
  /** Epoch millis the item was registered. */
  createdAt: number
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure, used by the TUI token + warnings)
// ---------------------------------------------------------------------------

/** Glyph word for a kind, used in the `[Image #… ]` token. */
export function kindToken(kind: MediaKind): "Image" | "Audio" | "Video" | "File" {
  switch (kind) {
    case "image":
      return "Image"
    case "audio":
      return "Audio"
    case "video":
      return "Video"
    case "document":
      return "File"
    default: {
      const _exhaustive: never = kind
      throw new Error(`unhandled media kind: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Human byte size with 1024-based units: `512B`, `461KB`, `1.2MB`, `3.4GB`.
 * Matches what users see in Finder/terminals for image sizes.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

/** Human duration: `8s`, `2m04s`, `1h02m`. Seconds zero-padded inside a minute. */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`
  if (m > 0) return `${m}m${String(sec).padStart(2, "0")}s`
  return `${sec}s`
}

/**
 * The cosmetic middle of a media token: `1466x1954 461KB`, `2m04s 500KB`,
 * `PDF 1.2MB`. Only the kind + id in the token are load-bearing; this part is
 * for the human and is allowed to drift.
 */
export function mediaDescriptor(
  item: Pick<MediaItem, "kind" | "mimeType" | "sizeBytes" | "dimensions" | "durationSec">,
): string {
  const parts: string[] = []
  if (item.dimensions) parts.push(`${item.dimensions.width}x${item.dimensions.height}`)
  if (item.durationSec != null) parts.push(formatDuration(item.durationSec))
  if (item.kind === "document") {
    const sub = item.mimeType.split("/")[1]?.toUpperCase()
    if (sub) parts.push(sub === "PLAIN" ? "TXT" : sub)
  }
  parts.push(formatBytes(item.sizeBytes))
  return parts.join(" ")
}

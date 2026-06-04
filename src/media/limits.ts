/**
 * Media limit checks. One pure verdict function is the single source of truth
 * for "can this be attached to a request for this model?". Today the verdict
 * drives "warn + drop"; later the same verdict drives a "compress?" modal
 * (see `private/multimodality-ingestion/design/20-design-spec.md` §10). Nothing
 * here does I/O or knows about a specific model id : limits are data.
 *
 * @module media/limits
 */

import type { ModalitySupport } from "../llm/capabilities.ts"

import { formatBytes, type MediaItem, type MediaKind, type MediaRejection } from "./types.ts"

// ---------------------------------------------------------------------------
// Limits (per provider/model, supplied as data)
// ---------------------------------------------------------------------------

/**
 * The byte/format/dimension budget a (provider, model) accepts. Built by the
 * provider adapter's `mediaLimits(model)`; the agent never hardcodes these.
 */
export interface MediaLimits {
  /** Mime types the model accepts, e.g. `image/jpeg`. Case-sensitive, lowercase. */
  acceptedMimeTypes: ReadonlySet<string>
  /** Hard cap for a single item. Anthropic default ~5 MB. */
  maxBytesPerItem: number
  /** Cap for the whole request payload (sum of attached media). Anthropic 32 MB. */
  maxRequestBytes: number
  /** Max attachments in one request. Anthropic 100 (200k-ctx models). */
  maxItemsPerRequest: number
  /** Longest edge in px; `null` to skip the check (we do not resize yet). */
  maxDimension: number | null
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type Verdict = { ok: true } | ({ ok: false } & MediaRejection)

const OK: Verdict = { ok: true }

/**
 * Byte length of `rawBytes` once base64-encoded (4 ASCII chars per 3 raw
 * bytes, rounded up to the 4-char quantum).
 *
 * Inline media is sent as a base64 string, and Anthropic (and OpenAI) enforce
 * their per-item and per-request byte caps on that ENCODED payload, not the
 * raw file. A 4.2 MB PNG becomes ~5.6 MB on the wire and blows the 5 MB cap —
 * so a raw-byte check passes an image the API then rejects with a 400
 * `invalid_request_error: image exceeds 5 MB maximum`. Checking the encoded
 * size lets us drop the item with a friendly warning before it is ever sent.
 *
 * For non-inline sources (URL / file_id) there is no expansion, so this is
 * mildly conservative there — but local drops/pastes are always inlined, so
 * the conservative bound only ever prevents a real 400, never a valid send.
 */
export function base64EncodedSize(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4
}

/** Map a media kind to the capability modality flag that gates it. */
export function kindModality(kind: MediaKind): keyof ModalitySupport {
  switch (kind) {
    case "image":
      return "image"
    case "audio":
      return "audio"
    case "video":
      return "video"
    case "document":
      return "pdf"
    default: {
      const _exhaustive: never = kind
      throw new Error(`unhandled media kind: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Per-item verdict: modality, mime type, byte size, and dimensions. Aggregate
 * checks (request total bytes, item count) live in {@link checkMediaSet}
 * because they depend on the whole attachment list, not one item.
 *
 * Pure. Deterministic. Safe to call on every keystroke.
 */
export function checkMedia(
  item: Pick<MediaItem, "kind" | "mimeType" | "sizeBytes" | "dimensions">,
  limits: MediaLimits,
  modalities: ModalitySupport,
  modelId = "this model",
): Verdict {
  if (!modalities[kindModality(item.kind)]) {
    return {
      ok: false,
      code: "unsupported-modality",
      message: `${modelId} doesn't accept ${item.kind} input`,
    }
  }
  if (!limits.acceptedMimeTypes.has(item.mimeType)) {
    return {
      ok: false,
      code: "unsupported-type",
      message: `${item.mimeType} isn't a supported type for ${modelId}`,
    }
  }
  // The API enforces its byte cap on the base64-encoded payload (inline media
  // is sent as base64, ~4/3 the raw size), so check the encoded size — a raw
  // check passes a 4.2 MB PNG that becomes 5.6 MB on the wire and the server
  // rejects with a 400. The message reports the encoded size so "4.2 MB
  // exceeds 5 MB" doesn't look like a math error.
  const encodedBytes = base64EncodedSize(item.sizeBytes)
  if (encodedBytes > limits.maxBytesPerItem) {
    return {
      ok: false,
      code: "too-large",
      message: `${formatBytes(item.sizeBytes)} (${formatBytes(
        encodedBytes,
      )} encoded) exceeds the ${formatBytes(limits.maxBytesPerItem)} limit for ${modelId}`,
    }
  }
  if (limits.maxDimension != null && item.dimensions) {
    const longEdge = Math.max(item.dimensions.width, item.dimensions.height)
    if (longEdge > limits.maxDimension) {
      return {
        ok: false,
        code: "dimensions",
        message: `${item.dimensions.width}x${item.dimensions.height} exceeds the ${limits.maxDimension}px limit for ${modelId}`,
      }
    }
  }
  return OK
}

/**
 * Aggregate verdict for a set of already-per-item-valid attachments: rejects
 * the trailing items that push the request over `maxItemsPerRequest` or
 * `maxRequestBytes`. Returns a parallel array of `Verdict`s (index-aligned to
 * `items`) so the caller can drop+warn exactly the offenders while keeping the
 * earlier ones.
 */
export function checkMediaSet(
  items: ReadonlyArray<Pick<MediaItem, "sizeBytes">>,
  limits: MediaLimits,
  modelId = "this model",
): Verdict[] {
  let runningBytes = 0
  return items.map((it, i): Verdict => {
    if (i >= limits.maxItemsPerRequest) {
      return {
        ok: false,
        code: "too-many",
        message: `more than ${limits.maxItemsPerRequest} attachments for ${modelId}`,
      }
    }
    // Aggregate the ENCODED sizes: the request budget is spent on the base64
    // payload, same reasoning as the per-item check in checkMedia.
    runningBytes += base64EncodedSize(it.sizeBytes)
    if (runningBytes > limits.maxRequestBytes) {
      return {
        ok: false,
        code: "request-too-large",
        message: `attachments total exceeds the ${formatBytes(
          limits.maxRequestBytes,
        )} request limit for ${modelId}`,
      }
    }
    return OK
  })
}

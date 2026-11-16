/**
 * Media limit checks. One pure verdict function is the single source of truth
 * for "can this be attached to a request for this model?". Today the verdict
 * drives "warn + drop"; later the same verdict drives a "compress?" modal
 * (see `private/multimodality-ingestion/design/20-design-spec.md` §10). Nothing
 * here does I/O or knows about a specific model id : limits are data.
 *
 * @module media/limits
 */

import type { SyntheticFacts } from "../../plugin-api/src/types/synthetic-text.ts"
import { FALLBACK_SYNTHETIC_TEXT, type SyntheticTextResolver } from "../agent/synthetic-text.ts"
import type { ModalitySupport } from "../llm/capabilities.ts"

import {
  mediaDimensionsTooLargeMessage,
  mediaTooLargeMessage,
  noModelLabel,
  requestTooLargeMessage,
  tooManyAttachmentsMessage,
  unsupportedModalityMessage,
  unsupportedTypeMessage,
} from "./PROMPTS.ts"
import type { MediaItem, MediaKind, MediaRejection } from "./types.ts"

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

/** The old text when the caller gave no model id. */
const NO_MODEL = noModelLabel()

/**
 * A rejection verdict whose message comes from `user_media.rejected` with
 * `site: "check"` (the bare reason, used for the warning and wrapped in the
 * model marker). `facts` holds the data facts without `site`, so the marker
 * can ask the same kind again. `old` is today's text, the fallback.
 */
function rejected(
  text: SyntheticTextResolver,
  code: MediaRejection["code"],
  facts: SyntheticFacts,
  old: () => string,
): Verdict {
  const all = { reason: code, ...facts }
  return {
    ok: false,
    code,
    message: text.resolve("user_media.rejected", { ...all, site: "check" }, old),
    facts: all,
  }
}

/** The `modelId` fact: absent when the caller gave none. */
function modelFact(modelId: string | undefined): SyntheticFacts {
  return modelId === undefined ? {} : { modelId }
}

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
      throw new Error(`unhandled media kind: ${String(kind satisfies never)}`)
    }
  }
}

/**
 * Per-item verdict: modality, mime type, byte size, and dimensions. Aggregate
 * checks (request total bytes, item count) live in {@link checkMediaSet}
 * because they depend on the whole attachment list, not one item.
 *
 * Pure. Deterministic. Safe to call on every keystroke. `text` resolves the
 * rejection message (kind `user_media.rejected`). Omitted: the old text.
 */
export function checkMedia(
  item: Pick<MediaItem, "kind" | "mimeType" | "sizeBytes" | "dimensions">,
  limits: MediaLimits,
  modalities: ModalitySupport,
  modelId?: string,
  text: SyntheticTextResolver = FALLBACK_SYNTHETIC_TEXT,
): Verdict {
  const model = modelId ?? NO_MODEL
  const base = { ...modelFact(modelId), kind: item.kind, mimeType: item.mimeType }
  if (!modalities[kindModality(item.kind)]) {
    return rejected(text, "unsupported-modality", base, () =>
      unsupportedModalityMessage(model, item.kind),
    )
  }
  if (!limits.acceptedMimeTypes.has(item.mimeType)) {
    return rejected(text, "unsupported-type", base, () =>
      unsupportedTypeMessage(item.mimeType, model),
    )
  }
  // The API enforces its byte cap on the base64-encoded payload (inline media
  // is sent as base64, ~4/3 the raw size), so check the encoded size — a raw
  // check passes a 4.2 MB PNG that becomes 5.6 MB on the wire and the server
  // rejects with a 400. The message reports the encoded size so "4.2 MB
  // exceeds 5 MB" doesn't look like a math error.
  const encodedBytes = base64EncodedSize(item.sizeBytes)
  if (encodedBytes > limits.maxBytesPerItem) {
    const facts = {
      ...base,
      sizeBytes: item.sizeBytes,
      encodedBytes,
      limitBytes: limits.maxBytesPerItem,
    }
    return rejected(text, "too-large", facts, () =>
      mediaTooLargeMessage({
        rawBytes: item.sizeBytes,
        encodedBytes,
        limitBytes: limits.maxBytesPerItem,
        modelId: model,
      }),
    )
  }
  if (limits.maxDimension != null && item.dimensions) {
    const { width, height } = item.dimensions
    const maxDimension = limits.maxDimension
    if (Math.max(width, height) > maxDimension) {
      return rejected(text, "dimensions", { ...base, width, height, maxDimension }, () =>
        mediaDimensionsTooLargeMessage({ width, height, maxDimension, modelId: model }),
      )
    }
  }
  return OK
}

/**
 * Aggregate verdict for a set of already-per-item-valid attachments: rejects
 * the trailing items that push the request over `maxItemsPerRequest` or
 * `maxRequestBytes`. Returns a parallel array of `Verdict`s (index-aligned to
 * `items`) so the caller can drop+warn exactly the offenders while keeping the
 * earlier ones. `text` resolves the rejection message (kind
 * `user_media.rejected`). Omitted: the old text.
 */
export function checkMediaSet(
  items: ReadonlyArray<Pick<MediaItem, "sizeBytes">>,
  limits: MediaLimits,
  modelId?: string,
  text: SyntheticTextResolver = FALLBACK_SYNTHETIC_TEXT,
): Verdict[] {
  const model = modelId ?? NO_MODEL
  let runningBytes = 0
  return items.map((it, i): Verdict => {
    if (i >= limits.maxItemsPerRequest) {
      const maxItems = limits.maxItemsPerRequest
      return rejected(text, "too-many", { ...modelFact(modelId), maxItems }, () =>
        tooManyAttachmentsMessage(maxItems, model),
      )
    }
    // Aggregate the ENCODED sizes: the request budget is spent on the base64
    // payload, same reasoning as the per-item check in checkMedia.
    runningBytes += base64EncodedSize(it.sizeBytes)
    if (runningBytes > limits.maxRequestBytes) {
      const limitBytes = limits.maxRequestBytes
      return rejected(text, "request-too-large", { ...modelFact(modelId), limitBytes }, () =>
        requestTooLargeMessage(limitBytes, model),
      )
    }
    return OK
  })
}

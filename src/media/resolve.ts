/**
 * Submit-time media resolution: the one place a prompt string + the media
 * registry become a multimodal user turn. Provider-neutral: the caller passes
 * the active model's {@link MediaLimits} + modalities and a `prepare` function;
 * this module parses the `[Image #id …]` tokens, re-validates each item against
 * the CURRENT model (it may have changed since attach), prepares the survivors,
 * and emits canonical blocks in image-then-text order.
 *
 * @module media/resolve
 */

import type {
  AudioSource,
  CanonicalBlock,
  FileSource,
  ImageSource,
} from "../llm/canonical-messages.ts"
import type { ModalitySupport } from "../llm/capabilities.ts"

import { checkMedia, checkMediaSet, type MediaLimits } from "./limits.ts"
import type { MediaRegistry } from "./registry.ts"
import { parseMediaTokens, replaceMediaTokens } from "./token.ts"
import { fitImageToBudget } from "./transform.ts"
import { kindToken, type MediaItem, type MediaRejection, type PreparedMedia } from "./types.ts"

/** Turn one prepared item into its embeddable canonical source. */
export type MediaPreparer = (item: MediaItem) => Promise<PreparedMedia>

export interface ResolvedTurn {
  /** Media blocks (in order) followed by the residual text block, if any. */
  content: CanonicalBlock[]
  /** Items that made it onto the turn. */
  attached: MediaItem[]
  /** Items dropped by a limit/modality check, with the reason (warn these). */
  rejected: Array<{ item: MediaItem; rejection: MediaRejection }>
  /** Token ids with no registry entry (stale pointers). */
  missing: string[]
  /** Oversize images that were auto-shrunk to fit, with a human summary (info-warn these). */
  fitted: Array<{ item: MediaItem; strategy: string }>
}

/** Build the base64 source appropriate to an item's kind. */
function base64Source(item: MediaItem, data: string): ImageSource | AudioSource | FileSource {
  switch (item.kind) {
    case "image":
    case "video":
      return { kind: "base64", mediaType: item.mimeType, data }
    case "audio":
      return { kind: "base64", format: item.mimeType.split("/")[1] ?? "wav", data }
    case "document":
      return { kind: "base64", mediaType: item.mimeType, data }
    default: {
      const _exhaustive: never = item.kind
      throw new Error(`unhandled media kind: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Default preparer: read the bytes and inline them as base64. No upload, no
 * network. This is what the Anthropic v1 image path uses (matches the CLI).
 */
export const inlineBase64Preparer: MediaPreparer = async (item) => {
  const bytes = await item.bytes()
  const data = Buffer.from(bytes).toString("base64")
  return { source: base64Source(item, data), bytesSent: bytes.length }
}

/** Wrap a prepared source in the canonical block matching the item's kind. */
function blockFromPrepared(item: MediaItem, prepared: PreparedMedia): CanonicalBlock | null {
  switch (item.kind) {
    case "image":
      return { type: "image", source: prepared.source as ImageSource }
    case "audio":
      return { type: "audio", source: prepared.source as AudioSource }
    case "document":
      return { type: "file", source: prepared.source as FileSource }
    case "video":
      // No canonical video block yet; modality gating rejects video upstream.
      return null
    default: {
      const _exhaustive: never = item.kind
      throw new Error(`unhandled media kind: ${String(_exhaustive)}`)
    }
  }
}

function reject(
  item: MediaItem,
  rejection: MediaRejection,
  into: Array<{ item: MediaItem; rejection: MediaRejection }>,
): void {
  item.state = "rejected"
  item.rejection = rejection
  into.push({ item, rejection })
}

export interface ResolveOptions {
  text: string
  registry: MediaRegistry
  limits: MediaLimits
  modalities: ModalitySupport
  modelId?: string
  /** Defaults to {@link inlineBase64Preparer}. */
  prepare?: MediaPreparer
}

/**
 * Resolve the media referenced by a prompt into canonical content blocks.
 * Pure aside from `prepare` (which may read bytes / upload) and the `state`
 * mutations it stamps on items it touches.
 */
export async function resolveMediaTurn(opts: ResolveOptions): Promise<ResolvedTurn> {
  const { text, registry, limits, modalities, modelId, prepare = inlineBase64Preparer } = opts

  // Ordered, de-duplicated ids referenced by the prompt.
  const orderedIds: string[] = []
  const seen = new Set<string>()
  for (const ref of parseMediaTokens(text)) {
    if (!seen.has(ref.id)) {
      seen.add(ref.id)
      orderedIds.push(ref.id)
    }
  }

  const rejected: Array<{ item: MediaItem; rejection: MediaRejection }> = []
  const missing: string[] = []
  const fitted: Array<{ item: MediaItem; strategy: string }> = []

  // Per-item validation against the current model. An oversize IMAGE gets one
  // chance to be auto-shrunk under the cap before we give up on it (see
  // maybeFit) — the rest of the turn proceeds with the fitted bytes.
  const candidates: MediaItem[] = []
  for (const id of orderedIds) {
    const item = registry.get(id)
    if (!item) {
      missing.push(id)
      continue
    }
    const v = checkMedia(item, limits, modalities, modelId)
    if (v.ok) {
      item.state = "validated"
      candidates.push(item)
      continue
    }
    const refit = await maybeFit(item, v.code, limits)
    if (refit) {
      refit.item.state = "validated"
      candidates.push(refit.item)
      fitted.push({ item: refit.item, strategy: refit.strategy })
    } else {
      reject(item, { code: v.code, message: v.message }, rejected)
    }
  }

  // Aggregate (request bytes + count) validation; drop the overflow.
  const attached: MediaItem[] = []
  checkMediaSet(candidates, limits, modelId).forEach((v, i) => {
    const item = candidates[i]
    if (!item) return
    if (v.ok) attached.push(item)
    else reject(item, { code: v.code, message: v.message }, rejected)
  })

  // Prepare survivors + build blocks (image-then-text ordering).
  const mediaBlocks: CanonicalBlock[] = []
  for (const item of attached) {
    item.state = "preparing"
    const prepared = await prepare(item)
    const block = blockFromPrepared(item, prepared)
    if (block) {
      mediaBlocks.push(block)
      item.state = "ready"
    }
  }

  // Residual text: a successfully-attached token is dropped (its bytes ride as
  // a real block), but a rejected/missing one leaves an inline marker so a
  // long-running agent still has a reference to what was meant to be there
  // instead of silently losing the turn's subject. See replaceMediaTokens.
  const markers = buildMarkers(rejected, missing)
  const residualText = replaceMediaTokens(text, (_kind, id) => markers.get(id) ?? "")
  const content: CanonicalBlock[] = [...mediaBlocks]
  if (residualText) content.push({ type: "text", text: residualText })

  return { content, attached, rejected, missing, fitted }
}

/**
 * Try to shrink an oversize image under the per-item budget. Returns a derived
 * {@link MediaItem} carrying the fitted bytes (so the rest of the pipeline is
 * oblivious), or `null` when the item is not a size-fixable image, the runtime
 * has no image backend, or even the most aggressive attempt won't fit.
 */
async function maybeFit(
  item: MediaItem,
  code: MediaRejection["code"],
  limits: MediaLimits,
): Promise<{ item: MediaItem; strategy: string } | null> {
  // Only size/dimension failures on images are fixable by resize+re-encode.
  if (item.kind !== "image") return null
  if (code !== "too-large" && code !== "dimensions") return null
  let original: Uint8Array
  try {
    original = await item.bytes()
  } catch {
    return null
  }
  const fit = await fitImageToBudget(original, { maxEncodedBytes: limits.maxBytesPerItem })
  if (!fit) return null
  const bytes = fit.bytes
  const derived: MediaItem = {
    ...item,
    mimeType: fit.mimeType,
    sizeBytes: bytes.length,
    dimensions: { width: fit.width, height: fit.height },
    bytes: async () => bytes,
    // A fresh prepared cache: the fitted bytes are a different payload.
    prepared: {},
  }
  return { item: derived, strategy: fit.strategy }
}

/** Build an id→marker map for the tokens that did NOT become real blocks. */
function buildMarkers(
  rejected: Array<{ item: MediaItem; rejection: MediaRejection }>,
  missing: string[],
): Map<string, string> {
  const markers = new Map<string, string>()
  for (const { item, rejection } of rejected) {
    markers.set(item.id, `[${kindToken(item.kind).toLowerCase()} not sent: ${rejection.message}]`)
  }
  for (const id of missing) {
    markers.set(id, `[attachment #${id} unavailable]`)
  }
  return markers
}

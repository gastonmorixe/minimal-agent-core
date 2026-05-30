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
import { parseMediaTokens, stripMediaTokens } from "./token.ts"
import type { MediaItem, MediaRejection, PreparedMedia } from "./types.ts"

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

  // Per-item validation against the current model.
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

  const residualText = stripMediaTokens(text)
  const content: CanonicalBlock[] = [...mediaBlocks]
  if (residualText) content.push({ type: "text", text: residualText })

  return { content, attached, rejected, missing }
}

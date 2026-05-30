/**
 * Anthropic-specific media limits, as data. Used by the agent's submit path
 * (legacy transport) and, later, by the Anthropic `ProviderAdapter.mediaLimits`
 * hook (canonical transport). Numbers come from the reconciled spec
 * `private/multimodality-ingestion/anthropic/10-anthropic-image-ingestion.md`.
 *
 * @module media/anthropic
 */

import type { MediaLimits } from "./limits.ts"

/** Image formats Anthropic vision accepts (no animation). */
export const ANTHROPIC_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

/** Document formats accepted via the `document` block. */
export const ANTHROPIC_DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "text/plain",
])

/**
 * Build the {@link MediaLimits} for an Anthropic vision model.
 *
 * - 32 MB request budget is the hard API wall.
 * - 5 MB/item is a sane TUI default (configurable later), well under the wall.
 * - 100 images/request for 200k-context models, 600 otherwise.
 * - 8000px is the documented max dimension (we reject rather than resize).
 */
export function anthropicMediaLimits(opts?: { contextWindow?: number }): MediaLimits {
  const is200k = (opts?.contextWindow ?? 0) >= 200_000
  return {
    acceptedMimeTypes: new Set([...ANTHROPIC_IMAGE_MIME_TYPES, ...ANTHROPIC_DOCUMENT_MIME_TYPES]),
    maxBytesPerItem: 5 * 1024 * 1024,
    maxRequestBytes: 32 * 1024 * 1024,
    maxItemsPerRequest: is200k ? 100 : 600,
    maxDimension: 8000,
  }
}

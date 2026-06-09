/**
 * Provider-NEUTRAL conservative media limits.
 *
 * The fallback used when a model's provider plugin does not implement the
 * `ProviderAdapter.mediaLimits(model)` hook (see `src/llm/provider.ts`).
 * Providers own their real limits (DIP: core depends on the hook, plugins
 * supply concretions — e.g. `plugins/llm-anthropic/media-limits.ts`).
 *
 * The numbers are a deliberate conservative floor that every current
 * vision-capable provider accepts: the common web image formats plus
 * pdf/plain-text documents, 5 MB per item, 32 MB per request, 100 items,
 * 8000px max dimension. A provider with tighter walls MUST implement the
 * hook; one with looser walls only loses headroom, never correctness.
 *
 * @module media/default-limits
 */

import type { MediaLimits } from "./limits.ts"

/** Image formats virtually every vision API accepts (no animation). */
export const DEFAULT_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

/** Document formats for providers with document blocks. */
export const DEFAULT_DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "text/plain",
])

/**
 * Build the neutral conservative {@link MediaLimits} floor.
 */
export function defaultMediaLimits(): MediaLimits {
  return {
    acceptedMimeTypes: new Set([...DEFAULT_IMAGE_MIME_TYPES, ...DEFAULT_DOCUMENT_MIME_TYPES]),
    maxBytesPerItem: 5 * 1024 * 1024,
    maxRequestBytes: 32 * 1024 * 1024,
    maxItemsPerRequest: 100,
    maxDimension: 8000,
  }
}

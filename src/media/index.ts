/**
 * Provider-neutral media ingestion. Barrel re-export.
 *
 * @module media
 */

export { ANTHROPIC_IMAGE_MIME_TYPES, anthropicMediaLimits } from "./anthropic.ts"
export {
  clipboardChangeCount,
  clipboardImage,
  clipboardImageSync,
  clipboardText,
  hasClipboardImage,
} from "./clipboard.ts"
export { looksLikeMediaDrop, parseDroppedPaths } from "./detect.ts"
export { mediaId, mediaIdFromSha, randomMediaId, sha256Hex } from "./id.ts"
export {
  ANTHROPIC_MODALITIES,
  type BuildUserContentOptions,
  buildAnthropicUserContent,
  type UserContentResult,
} from "./ingest.ts"
export {
  checkMedia,
  checkMediaSet,
  kindModality,
  type MediaLimits,
  type Verdict,
} from "./limits.ts"
export { type Dimensions, imageDimensions, mimeToKind, sniffMime } from "./probe.ts"
export { createMediaRegistry, fileSize, type MediaRegistry } from "./registry.ts"
export {
  inlineBase64Preparer,
  type MediaPreparer,
  type ResolvedTurn,
  type ResolveOptions,
  resolveMediaTurn,
} from "./resolve.ts"
export {
  formatMediaToken,
  MEDIA_TOKEN_RE,
  type MediaTokenRef,
  parseMediaTokens,
  stripMediaTokens,
} from "./token.ts"
export {
  formatBytes,
  formatDuration,
  kindToken,
  type MediaItem,
  type MediaKind,
  type MediaOrigin,
  type MediaRejection,
  type MediaRejectionCode,
  type MediaState,
  mediaDescriptor,
  type PreparedMedia,
} from "./types.ts"

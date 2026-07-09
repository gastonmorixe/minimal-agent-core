import { formatBytes, type MediaKind } from "./types.ts"

/** Returns the message saying a model does not accept a given media modality. */
export function unsupportedModalityMessage(modelId: string, kind: MediaKind): string {
  return `${modelId} doesn't accept ${kind} input`
}

/** Returns the message saying a MIME type is not supported for a model. */
export function unsupportedTypeMessage(mimeType: string, modelId: string): string {
  return `${mimeType} isn't a supported type for ${modelId}`
}

/** Returns the message saying a media attachment exceeds a model's size limit. */
export function mediaTooLargeMessage(args: {
  rawBytes: number
  encodedBytes: number
  limitBytes: number
  modelId: string
}): string {
  return `${formatBytes(args.rawBytes)} (${formatBytes(args.encodedBytes)} encoded) exceeds the ${formatBytes(args.limitBytes)} limit for ${args.modelId}`
}

/** Returns the message saying an image's pixel dimensions exceed a model's limit. */
export function mediaDimensionsTooLargeMessage(args: {
  width: number
  height: number
  maxDimension: number
  modelId: string
}): string {
  return `${args.width}x${args.height} exceeds the ${args.maxDimension}px limit for ${args.modelId}`
}

/** Returns the message saying too many attachments were sent for a model. */
export function tooManyAttachmentsMessage(maxItems: number, modelId: string): string {
  return `more than ${maxItems} attachments for ${modelId}`
}

/** Returns the message saying the attachments' total size exceeds the request limit. */
export function requestTooLargeMessage(limitBytes: number, modelId: string): string {
  return `attachments total exceeds the ${formatBytes(limitBytes)} request limit for ${modelId}`
}

/** Returns the message explaining a binary document can't be embedded in tool output. */
export function binaryDocumentRejectedMessage(args: {
  mimeType: string
  sizeBytes: number
}): string {
  return `${args.mimeType} (${formatBytes(args.sizeBytes)}) is a binary document. Tool output can include text and images but not documents, so it can't be embedded here. Ask the user to attach it to their message, or convert it to text/images first.`
}

/** Returns the message saying a media type can't be embedded in tool output. */
export function unsupportedEmbeddingMessage(args: { mimeType: string; sizeBytes: number }): string {
  return `${args.mimeType} (${formatBytes(args.sizeBytes)}) can't be embedded in tool output. Ask the user to attach it to their message instead.`
}

/** Returns the message saying a non-vision model can't be shown an image. */
export function unsupportedImageModalityMessage(args: {
  modelId: string
  mimeType: string
  sizeBytes: number
}): string {
  return `${args.modelId} doesn't accept image input, so this ${args.mimeType} (${formatBytes(args.sizeBytes)}) can't be shown to the model. Describe it for the user from context, or switch to a vision-capable model.`
}

/** Returns the message saying an image is too large to embed even after resizing. */
export function fittedImageTooLargeMessage(args: {
  sizeBytes: number
  limitBytes: number
  modelId: string
}): string {
  return `${formatBytes(args.sizeBytes)} image is too large to embed even after resizing (per-item cap ${formatBytes(args.limitBytes)} encoded for ${args.modelId}).`
}

/** Returns the summary marker describing an image shown to the model, with dimensions and any resize. */
export function imageSummaryMessage(args: {
  subtype: string
  sizeBytes: number
  dimensions: { width: number; height: number } | null
  fittedStrategy: string | null
}): string {
  const dims = args.dimensions ? `${args.dimensions.width}x${args.dimensions.height} ` : ""
  const base = `[${args.subtype} image ${dims}${formatBytes(args.sizeBytes)} shown to the model below]`
  if (args.fittedStrategy) return `${base.slice(0, -1)}, resized to fit (${args.fittedStrategy})]`
  return base
}

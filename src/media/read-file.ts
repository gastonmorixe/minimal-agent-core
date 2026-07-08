/**
 * Read-as-media policy: decide what the `Read` tool should do with a file's
 * raw bytes for the CURRENT model.
 *
 * The `Read` tool historically decoded every file as UTF-8 text. That turns a
 * screenshot PNG into mojibake and makes a vision-capable model conclude it
 * "can't read images" — even though the provider accepts image input and the
 * canonical layer already carries images inside a `tool_result` (see
 * `llm/canonical-messages`' `ToolResultContentBlock`). This module
 * is the single, pure decision point that closes that gap:
 *
 *   - recognized image + model accepts images  → embed it as an
 *     {@link ImageBlock} (auto-shrunk under the per-item byte cap first, because
 *     a 4K screenshot base64-encodes past Anthropic's 5 MB wall);
 *   - recognized image the model/limits reject → an honest, actionable message
 *     (modality off, or too large to fit) instead of bytes;
 *   - recognized non-image binary (PDF, …)     → a message: tool outputs can
 *     carry text + images, not documents, so steer the caller elsewhere;
 *   - everything else (text, unknown bytes)     → defer to the caller's normal
 *     UTF-8 text read (byte-identical to the old behavior).
 *
 * Pure + provider-neutral: the caller passes the active model's
 * {@link ModalitySupport} + {@link MediaLimits}; nothing here does I/O beyond the
 * in-memory image transform, and it never throws into the tool path.
 *
 * Design: `private/multimodality-ingestion/design/20-design-spec.md` (the same
 * verdict + fit-to-budget machinery the submit path uses, applied to tool
 * output).
 *
 * @module media/read-file
 */

import type { ImageBlock, ImageSource } from "../llm/canonical-messages.ts"
import type { ModalitySupport } from "../llm/capabilities.ts"

import { base64EncodedSize, checkMedia, type MediaLimits } from "./limits.ts"
import {
  binaryDocumentRejectedMessage,
  fittedImageTooLargeMessage,
  imageSummaryMessage,
  unsupportedEmbeddingMessage,
  unsupportedImageModalityMessage,
} from "./PROMPTS.ts"
import { imageDimensions, mimeToKind, sniffMime } from "./probe.ts"
import { type FitResult, fitImageToBudget } from "./transform.ts"
import { formatBytes, type MediaKind } from "./types.ts"

/** Image fitter signature (so tests can inject a deterministic stub). */
export type ImageFitter = (
  bytes: Uint8Array,
  opts: { maxEncodedBytes: number; maxLongEdge?: number },
) => Promise<FitResult | null>

/** Inputs to {@link decideReadFile}. */
export interface ReadFileMediaContext {
  /** Input modalities the active model accepts. */
  modalities: ModalitySupport
  /** Byte/format/dimension budget for the active (provider, model). */
  limits: MediaLimits
  /** Model id for human-readable messages. */
  modelId?: string
  /** Override the image fitter (default {@link fitImageToBudget}). Tests inject. */
  fit?: ImageFitter
}

/**
 * What {@link decideReadFile} concluded.
 *
 * - `text`: not embeddable media — caller reads the bytes as UTF-8 text
 *   exactly as before (no behavior change for source files, logs, etc.).
 * - `image`: embed `block` in the `tool_result`; `summary` is the
 *   model-facing one-liner to sit alongside it. `fitted` is the resize
 *   strategy string when the image was shrunk to fit, else `null`.
 * - `rejected`: recognized media the model/limits won't accept, or a binary
 *   tool outputs can't carry; `message` explains and is shown to the model.
 */
export type ReadFileDecision =
  | { kind: "text" }
  | {
      kind: "image"
      block: ImageBlock
      summary: string
      fitted: string | null
      bytesSent: number
      mimeType: string
      dimensions: { width: number; height: number } | null
    }
  | {
      kind: "rejected"
      code: "unsupported-modality" | "too-large" | "unsupported-type"
      message: string
    }

/** Build the canonical inline-base64 image block for `bytes`. */
function imageBlock(mimeType: string, bytes: Uint8Array): ImageBlock {
  const source: ImageSource = {
    kind: "base64",
    mediaType: mimeType,
    data: Buffer.from(bytes).toString("base64"),
  }
  return { type: "image", source }
}

/**
 * Decide how the `Read` tool should treat `bytes` (already loaded from disk).
 *
 * The decision is content-addressed: the real mime is sniffed from magic bytes,
 * never the file extension, so a `.png` that actually holds text stays on the
 * text path and a screenshot with no extension is still recognized as an image.
 */
export async function decideReadFile(
  bytes: Uint8Array,
  ctx: ReadFileMediaContext,
): Promise<ReadFileDecision> {
  const mimeType = sniffMime(bytes)

  // Unrecognized bytes → defer to the caller's UTF-8 text read. This is the
  // common case (source files, logs, JSON) and is byte-identical to the old
  // Read behavior. A `.png` whose contents are actually text lands here too.
  if (mimeType === "application/octet-stream") return { kind: "text" }

  const kind: MediaKind = mimeToKind(mimeType)
  const modelId = ctx.modelId ?? "this model"

  if (kind === "image") {
    return decideImage(bytes, mimeType, ctx, modelId)
  }

  // Recognized non-image binary (PDF today). Tool outputs can carry text +
  // images, not documents (the wire `tool_result` content is text|image only),
  // so we can't embed it. Be honest and actionable instead of returning bytes.
  if (kind === "document") {
    return {
      kind: "rejected",
      code: "unsupported-type",
      message: binaryDocumentRejectedMessage({ mimeType, sizeBytes: bytes.length }),
    }
  }

  // audio/video read off disk: not embeddable via a tool_result.
  return {
    kind: "rejected",
    code: "unsupported-type",
    message: unsupportedEmbeddingMessage({ mimeType, sizeBytes: bytes.length }),
  }
}

/** Image branch of {@link decideReadFile}. */
async function decideImage(
  bytes: Uint8Array,
  mimeType: string,
  ctx: ReadFileMediaContext,
  modelId: string,
): Promise<ReadFileDecision> {
  if (!ctx.modalities.image) {
    return {
      kind: "rejected",
      code: "unsupported-modality",
      message: unsupportedImageModalityMessage({ modelId, mimeType, sizeBytes: bytes.length }),
    }
  }

  const dimensions = imageDimensions(bytes, mimeType)
  const verdict = checkMedia(
    { kind: "image", mimeType, sizeBytes: bytes.length, dimensions },
    ctx.limits,
    ctx.modalities,
    modelId,
  )

  if (verdict.ok) {
    return {
      kind: "image",
      block: imageBlock(mimeType, bytes),
      summary: imageSummary(mimeType, bytes.length, dimensions, null),
      fitted: null,
      bytesSent: bytes.length,
      mimeType,
      dimensions,
    }
  }

  // A "dimensions" rejection means the cheap header parse (imageDimensions,
  // above) already proved the image is over the pixel-count cap. Resizing it
  // would mean fully DECODING an image we already know is enormous — and a
  // tiny, highly-compressed file can declare e.g. 60000x60000 px, so that
  // decode is a multi-GB / OOM decompression bomb. Bail without ever decoding,
  // exactly like the unsupported-type early return. The cap is in the message.
  if (verdict.code === "dimensions") {
    return { kind: "rejected", code: "unsupported-type", message: verdict.message }
  }

  // The only image rejection worth trying to repair is byte size: a 4K
  // screenshot shrinks to ~1568px with no loss the model would notice, and
  // fitImageToBudget caps the decode by long edge. Unsupported-type (e.g. a
  // future heic) can't be fixed by resizing.
  if (verdict.code !== "too-large") {
    return { kind: "rejected", code: "unsupported-type", message: verdict.message }
  }

  const fit = ctx.fit ?? fitImageToBudget
  const fitted = await fit(bytes, { maxEncodedBytes: ctx.limits.maxBytesPerItem })
  if (!fitted) {
    return {
      kind: "rejected",
      code: "too-large",
      message: fittedImageTooLargeMessage({
        sizeBytes: bytes.length,
        limitBytes: ctx.limits.maxBytesPerItem,
        modelId,
      }),
    }
  }

  const fittedDims = { width: fitted.width, height: fitted.height }
  return {
    kind: "image",
    block: imageBlock(fitted.mimeType, fitted.bytes),
    summary: imageSummary(fitted.mimeType, fitted.bytes.length, fittedDims, fitted.strategy),
    fitted: fitted.strategy,
    bytesSent: fitted.bytes.length,
    mimeType: fitted.mimeType,
    dimensions: fittedDims,
  }
}

/** Model-facing one-liner that rides alongside the embedded image. */
export function imageSummary(
  mimeType: string,
  sizeBytes: number,
  dimensions: { width: number; height: number } | null,
  fittedStrategy: string | null,
): string {
  const sub = mimeType.split("/")[1]?.toUpperCase() ?? "IMAGE"
  return imageSummaryMessage({
    subtype: sub,
    sizeBytes,
    dimensions,
    fittedStrategy,
  })
}

/** Re-export so callers don't reach past this module for the budget math. */
export { base64EncodedSize }

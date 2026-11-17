/**
 * Shared modality gating.
 *
 * Turns unsupported image / audio / file inputs into structured
 * `CapabilityViolation`s instead of letting the request-body builders
 * silently drop them. This is the canonical layer's "no silent feature
 * dropping" principle applied to multimodal input: every provider's
 * `validate()` calls this so the behavior is identical across providers.
 *
 * Wave D-2: moved WHOLE into the leaf contract package. Its entire dependency
 * graph (`CanonicalMessage`, `Capabilities`, `CapabilityViolation`) now
 * resolves in-package, so plugins can validate modality without reaching into
 * `src/`. The `src/llm/modality-check.ts` shim re-exports this module.
 *
 * @module llm/modality-check
 */

import type {
  AudioBlock,
  CanonicalBlock,
  CanonicalMessage,
  FileBlock,
  ImageBlock,
  TextBlock,
  ToolResultBlock,
  VideoBlock,
} from "./canonical-messages.ts"
import type { Capabilities } from "./capabilities.ts"
import { CapabilityViolation } from "./errors.ts"

/**
 * Scan a request's messages for multimodal blocks and return a
 * `CapabilityViolation` for each modality the model doesn't accept.
 * `tool_result` content is inspected too (it can carry images).
 *
 * - `image`  → gated on `caps.modalities.image`
 * - `audio`  → gated on `caps.modalities.audio`
 * - `video`  → gated on `caps.modalities.video`
 * - `file`   → gated on `caps.modalities.pdf` (documents)
 */
export function modalityViolations(
  messages: CanonicalMessage[],
  caps: Capabilities,
  modelId: string,
): CapabilityViolation[] {
  let hasImage = false
  let hasAudio = false
  let hasFile = false
  let hasVideo = false

  for (const msg of messages) {
    for (const block of msg.content) {
      switch (block.type) {
        case "image":
          hasImage = true
          break
        case "audio":
          hasAudio = true
          break
        case "file":
          hasFile = true
          break
        case "video":
          hasVideo = true
          break
        case "tool_result":
          for (const inner of block.content) {
            if (inner.type === "image") hasImage = true
          }
          break
        default:
          break
      }
    }
  }

  const errors: CapabilityViolation[] = []
  if (hasImage && !caps.modalities.image) {
    errors.push(
      new CapabilityViolation("modalities", `model ${modelId} doesn't accept image input`),
    )
  }
  if (hasAudio && !caps.modalities.audio) {
    errors.push(
      new CapabilityViolation("modalities", `model ${modelId} doesn't accept audio input`),
    )
  }
  if (hasVideo && !caps.modalities.video) {
    errors.push(
      new CapabilityViolation("modalities", `model ${modelId} doesn't accept video input`),
    )
  }
  if (hasFile && !caps.modalities.pdf) {
    errors.push(
      new CapabilityViolation("modalities", `model ${modelId} doesn't accept file/PDF input`),
    )
  }
  return errors
}

// ---------------------------------------------------------------------------
// Placeholders (no silent drop)
// ---------------------------------------------------------------------------

/** A canonical block that carries one attachment. */
export type AttachmentBlock = ImageBlock | AudioBlock | FileBlock | VideoBlock

/**
 * The MIME type of an attachment block, when its source names one (base64
 * always does; a url may; a file_id never does).
 */
export function attachmentMimeType(block: AttachmentBlock): string | undefined {
  const src = block.source
  if (src.kind === "file_id") return undefined
  if (block.type === "audio") {
    if (src.kind !== "base64") return undefined
    const a = block.source as Extract<AudioBlock["source"], { kind: "base64" }>
    return (a.mediaType ?? `audio/${a.format}`).toLowerCase()
  }
  const mediaType = (src as { mediaType?: string }).mediaType
  return mediaType?.toLowerCase()
}

/** Word for the attachment kind in a placeholder (`file` for a document). */
function attachmentWord(block: AttachmentBlock): string {
  switch (block.type) {
    case "image":
      return "image"
    case "audio":
      return "audio"
    case "video":
      return "video"
    case "file":
      return "file"
    default:
      throw new Error(`unhandled attachment block: ${String(block satisfies never)}`)
  }
}

/**
 * The text block an encoder sends in place of an attachment it cannot send,
 * so the model knows that an attachment was there (no silent drop). The block
 * keeps the cache hint of the original block, so a cache breakpoint is not
 * lost. The text is data only (kind, format, model id).
 *
 * @param block - The attachment the encoder cannot send.
 * @param modelId - The id of the target model.
 * @returns A canonical text block.
 */
export function unsupportedAttachmentText(block: AttachmentBlock, modelId: string): TextBlock {
  const word = attachmentWord(block)
  const mime = attachmentMimeType(block)
  const format = mime ?? (block.source.kind === "file_id" ? "file_id reference" : word)
  const text = `[${word} attachment not sent: ${modelId} does not accept ${format}]`
  return block.cache ? { type: "text", text, cache: block.cache } : { type: "text", text }
}

/** `application/*` types that hold plain text. */
const TEXT_LIKE_APPLICATION = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/sql",
  "application/toml",
])

/**
 * True when a MIME type holds plain text: `text/*` (txt, md, csv, html,
 * code), JSON, XML, YAML, and the `+json` / `+xml` suffix types. An encoder
 * with a plain-text document block sends these as `text/plain`.
 */
export function isTextLikeMime(mime: string): boolean {
  const m = (mime.split(";")[0] ?? "").trim().toLowerCase()
  return (
    m.startsWith("text/") ||
    TEXT_LIKE_APPLICATION.has(m) ||
    m.endsWith("+json") ||
    m.endsWith("+xml")
  )
}

/**
 * Return a deep-copied message list where each unsupported multimodal block
 * (image, audio, video, file) is replaced by its
 * {@link unsupportedAttachmentText} placeholder. Inside a `tool_result`, an
 * unsupported image becomes a placeholder text block, so the tool_use /
 * tool_result pairing stays valid.
 *
 * Designed as the `degrade` payload for validators to offer when the ONLY
 * violations are modality mismatches: the caller can accept the degrade
 * and the conversation continues, and the model still sees where an
 * attachment was, instead of failing the whole request.
 *
 * @param messages - The canonical messages (not mutated).
 * @param caps - The target model capabilities.
 * @param modelId - The target model id, named in the placeholder. Omitted:
 *   "this model".
 */
export function stripUnsupportedModalities(
  messages: CanonicalMessage[],
  caps: Capabilities,
  modelId = "this model",
): CanonicalMessage[] {
  const stripImage = !caps.modalities.image
  const stripAudio = !caps.modalities.audio
  const stripFile = !caps.modalities.pdf
  const stripVideo = !caps.modalities.video

  if (!stripImage && !stripAudio && !stripFile && !stripVideo) return messages

  const placeholder = (b: AttachmentBlock): TextBlock => unsupportedAttachmentText(b, modelId)
  return messages.map((msg) => {
    const content = msg.content.map((block): CanonicalBlock => {
      if (block.type === "image" && stripImage) return placeholder(block)
      if (block.type === "audio" && stripAudio) return placeholder(block)
      if (block.type === "file" && stripFile) return placeholder(block)
      if (block.type === "video" && stripVideo) return placeholder(block)
      if (block.type === "tool_result") {
        // The tool_result is always kept: dropping it would orphan the
        // preceding assistant's tool_use and cause an API reject.
        const cleaned = (block as ToolResultBlock).content.map((inner) =>
          inner.type === "image" && stripImage ? placeholder(inner) : inner,
        )
        return { ...block, content: cleaned }
      }
      return block
    })
    return { ...msg, content }
  })
}

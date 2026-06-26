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

import type { CanonicalBlock, CanonicalMessage, ToolResultBlock } from "./canonical-messages.ts"
import type { Capabilities } from "./capabilities.ts"
import { CapabilityViolation } from "./errors.ts"

/**
 * Scan a request's messages for multimodal blocks and return a
 * `CapabilityViolation` for each modality the model doesn't accept.
 * `tool_result` content is inspected too (it can carry images).
 *
 * - `image`  → gated on `caps.modalities.image`
 * - `audio`  → gated on `caps.modalities.audio`
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
  if (hasFile && !caps.modalities.pdf) {
    errors.push(
      new CapabilityViolation("modalities", `model ${modelId} doesn't accept file/PDF input`),
    )
  }
  return errors
}

/**
 * Return a deep-copied message list with unsupported multimodal blocks
 * (image, audio, file) removed. When a block inside a `tool_result` is
 * stripped, the empty tool_result block is kept so the tool_use / tool_result
 * pairing stays valid.
 *
 * Designed as the `degrade` payload for validators to offer when the ONLY
 * violations are modality mismatches: the caller can accept the degrade
 * and the conversation continues with images/audio/files silently removed
 * instead of failing the whole request.
 */
export function stripUnsupportedModalities(
  messages: CanonicalMessage[],
  caps: Capabilities,
): CanonicalMessage[] {
  const stripImage = !caps.modalities.image
  const stripAudio = !caps.modalities.audio
  const stripFile = !caps.modalities.pdf

  if (!stripImage && !stripAudio && !stripFile) return messages

  return messages.map((msg) => {
    const filtered = msg.content
      .map((block) => {
        if (block.type === "image" && stripImage) return null
        if (block.type === "audio" && stripAudio) return null
        if (block.type === "file" && stripFile) return null
        if (block.type === "tool_result") {
          const cleaned = (block as ToolResultBlock).content.filter((inner) => {
            if (inner.type === "image" && stripImage) return false
            return true
          })
          // Keep the tool_result even if all inner blocks were stripped:
          // an empty tool_result is a valid response for a tool_use whose
          // output was just an image the model can't see. Dropping the
          // tool_result would orphan the preceding assistant's tool_use
          // and cause an API reject.
          return { ...block, content: cleaned } as CanonicalBlock
        }
        return block
      })
      .filter((b): b is CanonicalBlock => b !== null)

    return { ...msg, content: filtered }
  })
}

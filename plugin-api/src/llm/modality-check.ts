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

import type { CanonicalMessage } from "./canonical-messages.ts"
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

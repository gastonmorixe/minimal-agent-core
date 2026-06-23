/**
 * Capability validation for the Ollama Cloud adapter.
 *
 * Given a `CanonicalRequest` and the resolved model view, return the list of
 * `CapabilityViolation`s. Pure: no network, no I/O. Safe to call before
 * dispatch (mirrors the other providers' `validate`).
 *
 * @module llm/providers/ollama/validate
 */

import type { CanonicalRequest } from "@minimal-agent/plugin-api/llm/canonical-request"
import { CapabilityViolation } from "@minimal-agent/plugin-api/llm/errors"
import { modalityViolations } from "@minimal-agent/plugin-api/llm/modality-check"
import type { ProviderValidationResult } from "@minimal-agent/plugin-api/llm/provider-plugin"
import type { ModelView } from "@minimal-agent/plugin-api/types/host-capabilities"

/**
 * Validate a canonical request against an Ollama Cloud model's declared
 * capabilities and return the violations found.
 */
export function validateOllamaRequest(
  req: CanonicalRequest,
  model: ModelView,
): ProviderValidationResult {
  const errors: CapabilityViolation[] = []
  const caps = model.capabilities

  // Sampling knobs (Ollama exposes temperature/top_p/top_k/seed/stop).
  if (req.generation?.temperature !== undefined && !caps.acceptsTemperature) {
    errors.push(
      new CapabilityViolation("acceptsTemperature", `model ${model.id} rejects temperature`),
    )
  }
  if (req.generation?.topP !== undefined && !caps.acceptsTopP) {
    errors.push(new CapabilityViolation("acceptsTopP", `model ${model.id} rejects top_p`))
  }
  if (req.generation?.topK !== undefined && !caps.acceptsTopK) {
    errors.push(new CapabilityViolation("acceptsTopK", `model ${model.id} rejects top_k`))
  }
  if (req.generation?.seed !== undefined && !caps.acceptsSeed) {
    errors.push(new CapabilityViolation("acceptsSeed", `model ${model.id} rejects seed`))
  }

  // Thinking. Adaptive/extended require the model to think.
  const thinking = req.thinking
  if (thinking) {
    const canThink = caps.thinking.adaptive || caps.effort.levels.length > 0
    if (thinking.mode === "adaptive" && !canThink) {
      errors.push(
        new CapabilityViolation("thinking.adaptive", `model ${model.id} doesn't support thinking`),
      )
    }
    if (thinking.mode === "extended") {
      // Ollama toggles thinking on/off (or by discrete level); it has no
      // explicit token-budget extended-thinking mode.
      errors.push(
        new CapabilityViolation(
          "thinking.extended",
          `model ${model.id} has no budget-based extended thinking (use effort or adaptive)`,
        ),
      )
    }
  }

  // Effort / reasoning level.
  if (req.effort && !caps.effort.levels.includes(req.effort)) {
    errors.push(
      new CapabilityViolation(
        "effort",
        `model ${model.id} reasoning levels are [${caps.effort.levels.join(", ")}], not "${req.effort}"`,
      ),
    )
  }

  // Mid-conversation system messages.
  const hasMidConvSystem = req.messages.some((m) => m.role === "system")
  if (hasMidConvSystem && !caps.midConversationSystem) {
    errors.push(
      new CapabilityViolation(
        "midConversationSystem",
        `model ${model.id} rejects role:"system" inside messages[]`,
      ),
    )
  }

  // Speed:"fast" is an Anthropic concept; Ollama has no metered fast tier.
  if (req.speed === "fast" && !caps.speedFast) {
    errors.push(
      new CapabilityViolation("speedFast", `model ${model.id} doesn't support speed:"fast"`),
    )
  }

  // Structured outputs.
  if (req.outputFormat?.type === "json_schema" && !caps.structuredOutputs) {
    errors.push(
      new CapabilityViolation(
        "structuredOutputs",
        `model ${model.id} doesn't support structured outputs`,
      ),
    )
  }

  // Server-side history pointer is not an Ollama concept.
  if (req.previousResponseId && !caps.serverSideHistory) {
    errors.push(
      new CapabilityViolation(
        "serverSideHistory",
        `model ${model.id} doesn't accept previousResponseId; send full messages[]`,
      ),
    )
  }

  // Multimodal input gating (image/audio/file) — shared across providers.
  errors.push(...modalityViolations(req.messages, caps, model.id))

  return { ok: errors.length === 0, errors }
}

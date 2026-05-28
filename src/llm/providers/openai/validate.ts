/**
 * Capability validation for the OpenAI adapter (Chat + Responses).
 *
 * Given a `CanonicalRequest` and the resolved `ModelEntry`, return the
 * list of `CapabilityViolation`s. Pure : no network, no I/O. Safe to
 * call before dispatch (mirrors `anthropic/validate.ts`).
 *
 * @module llm/providers/openai/validate
 */

import type { CanonicalRequest } from "../../canonical-request.ts"
import { CapabilityViolation } from "../../errors.ts"
import type { ModelEntry } from "../../model-registry.ts"
import type { ValidationResult } from "../../provider.ts"

export function validateOpenAIRequest(req: CanonicalRequest, model: ModelEntry): ValidationResult {
  const errors: CapabilityViolation[] = []
  const caps = model.capabilities

  // Sampling. gpt-4o-family accepts temperature/top_p; reasoning models
  // (gpt-5.x, o-series) reject them.
  if (req.generation?.temperature !== undefined && !caps.acceptsTemperature) {
    errors.push(
      new CapabilityViolation("acceptsTemperature", `model ${model.id} rejects temperature`),
    )
  }
  if (req.generation?.topP !== undefined && !caps.acceptsTopP) {
    errors.push(new CapabilityViolation("acceptsTopP", `model ${model.id} rejects top_p`))
  }
  if (req.generation?.topK !== undefined && !caps.acceptsTopK) {
    // OpenAI has no top_k knob at all.
    errors.push(new CapabilityViolation("acceptsTopK", `model ${model.id} has no top_k`))
  }
  if (req.generation?.seed !== undefined && !caps.acceptsSeed) {
    errors.push(new CapabilityViolation("acceptsSeed", `model ${model.id} rejects seed`))
  }

  // Thinking. Adaptive reasoning streams back only on the Responses
  // surface; Chat accepts reasoning_effort but never streams summaries.
  const thinking = req.thinking
  if (thinking) {
    if (thinking.mode === "adaptive" && !caps.thinking.adaptive) {
      errors.push(
        new CapabilityViolation(
          "thinking.adaptive",
          `model ${model.id} doesn't stream adaptive reasoning on this surface (use the Responses surface)`,
        ),
      )
    }
    if (thinking.mode === "extended" && !caps.thinking.extended) {
      errors.push(
        new CapabilityViolation(
          "thinking.extended",
          `model ${model.id} doesn't support extended thinking with budget_tokens (use effort)`,
        ),
      )
    }
    if (
      (thinking.mode === "adaptive" || thinking.mode === "extended") &&
      (thinking.display === "visible" || thinking.display === "summary") &&
      !caps.thinking.visible
    ) {
      errors.push(
        new CapabilityViolation(
          "thinking.visible",
          `model ${model.id} can't surface visible reasoning deltas on this surface`,
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

  // Mid-conversation system messages (`role:"system"` inside messages[]).
  const hasMidConvSystem = req.messages.some((m) => m.role === "system")
  if (hasMidConvSystem && !caps.midConversationSystem) {
    errors.push(
      new CapabilityViolation(
        "midConversationSystem",
        `model ${model.id} rejects role:"system" inside messages[]`,
      ),
    )
  }

  // Speed. OpenAI's metered "fast" tier is a vendor extension we don't
  // wire, so any speed:"fast" request on a model that doesn't declare it
  // is a violation rather than a silent drop.
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

  // Assistant prefill (a trailing assistant message the model continues).
  const last = req.messages[req.messages.length - 1]
  if (
    last?.role === "assistant" &&
    !caps.assistantPrefill &&
    last.content.some((b) => b.type === "text" && b.text.length > 0)
  ) {
    errors.push(
      new CapabilityViolation("assistantPrefill", `model ${model.id} rejects assistant prefill`),
    )
  }

  // Server-side history pointer. Valid on the Responses surface
  // (`previous_response_id`); rejected on Chat Completions.
  if (req.previousResponseId && !caps.serverSideHistory) {
    errors.push(
      new CapabilityViolation(
        "serverSideHistory",
        `model ${model.id} (Chat surface) doesn't accept previousResponseId; send full messages[]`,
      ),
    )
  }

  return { ok: errors.length === 0, errors }
}

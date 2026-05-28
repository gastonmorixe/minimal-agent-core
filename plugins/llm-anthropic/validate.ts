/**
 * Capability validation for the Anthropic adapter.
 *
 * Given a `CanonicalRequest` and the resolved `ModelEntry`, return
 * the list of `CapabilityViolation`s and (optionally) a degraded
 * request the caller can opt into instead of failing.
 *
 * Pure : no network, no I/O. Safe to call before dispatch.
 *
 * @module llm/providers/anthropic/validate
 */

import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { CapabilityViolation } from "../../src/llm/errors.ts"
import type { ModelEntry } from "../../src/llm/model-registry.ts"
import type { ValidationResult } from "../../src/llm/provider.ts"

export function validateAnthropicRequest(
  req: CanonicalRequest,
  model: ModelEntry,
): ValidationResult {
  const errors: CapabilityViolation[] = []
  const caps = model.capabilities

  // Sampling
  if (req.generation?.temperature !== undefined && !caps.acceptsTemperature) {
    errors.push(
      new CapabilityViolation(
        "acceptsTemperature",
        `model ${model.id} rejects temperature (adaptive-only)`,
      ),
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

  // Thinking
  const thinking = req.thinking
  if (thinking) {
    if (thinking.mode === "adaptive" && !caps.thinking.adaptive) {
      errors.push(
        new CapabilityViolation(
          "thinking.adaptive",
          `model ${model.id} doesn't support adaptive thinking`,
        ),
      )
    }
    if (thinking.mode === "extended" && !caps.thinking.extended) {
      errors.push(
        new CapabilityViolation(
          "thinking.extended",
          `model ${model.id} doesn't support extended thinking with budget_tokens (use adaptive)`,
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
          `model ${model.id} can't surface visible thinking deltas`,
        ),
      )
    }
  }

  // Effort
  if (req.effort && !caps.effort.levels.includes(req.effort)) {
    errors.push(
      new CapabilityViolation(
        "effort",
        `model ${model.id} effort levels are [${caps.effort.levels.join(", ")}], not "${req.effort}"`,
      ),
    )
  }

  // Mid-conversation system messages
  const hasMidConvSystem = req.messages.some((m) => m.role === "system")
  if (hasMidConvSystem && !caps.midConversationSystem) {
    errors.push(
      new CapabilityViolation(
        "midConversationSystem",
        `model ${model.id} rejects role:"system" inside messages[] (no mid-conversation-system beta)`,
      ),
    )
  }

  // Speed
  if (req.speed === "fast" && !caps.speedFast) {
    errors.push(
      new CapabilityViolation("speedFast", `model ${model.id} doesn't support speed:"fast"`),
    )
  }

  // Output format
  if (req.outputFormat?.type === "json_schema" && !caps.structuredOutputs) {
    errors.push(
      new CapabilityViolation(
        "structuredOutputs",
        `model ${model.id} doesn't support output_config.format`,
      ),
    )
  }

  // 1M alias on a model that doesn't support it
  if (req.modelId.includes("[1m]") && model.capabilities.contextWindow < 1_000_000) {
    errors.push(
      new CapabilityViolation(
        "contextWindow",
        `model ${model.id} can't honor the [1m] context alias`,
      ),
    )
  }

  // Assistant prefill (last assistant message with partial content)
  const last = req.messages[req.messages.length - 1]
  if (
    last?.role === "assistant" &&
    !caps.assistantPrefill &&
    last.content.some((b) => b.type === "text" && b.text.length > 0)
  ) {
    errors.push(
      new CapabilityViolation(
        "assistantPrefill",
        `model ${model.id} rejects assistant prefill (use output_config.format instead)`,
      ),
    )
  }

  // Server-side history pointer is OpenAI-only
  if (req.previousResponseId) {
    errors.push(
      new CapabilityViolation(
        "serverSideHistory",
        "Anthropic Messages doesn't accept previousResponseId; send full messages[]",
      ),
    )
  }

  return { ok: errors.length === 0, errors }
}

/**
 * OpenRouter model registry entries.
 *
 * OpenRouter ids are namespaced slugs (`openai/gpt-4o-mini`,
 * `anthropic/claude-3.5-sonnet`, …). All register on the SHARED
 * `openai-chat-completions` surface — OpenRouter normalizes every upstream model to
 * the OpenAI Chat Completions wire format, so the DeepSeek/OpenAI chat
 * translator handles them unchanged. Only a representative few are
 * registered; any other slug still works on the wire (the CLI doesn't
 * gate on the registry), just without a local cost estimate.
 *
 * @module llm/providers/openrouter/models
 */

import { registerModel } from "../../src/llm/model-registry.ts"
import { CAPS_OPENROUTER_CHAT } from "./capabilities.ts"
import { PRICING_OR_CLAUDE_35_SONNET, PRICING_OR_GPT_4O_MINI } from "./pricing.ts"

/** Populate the registry with a representative OpenRouter catalog. */
export function registerOpenRouterModels(): string[] {
  registerModel({
    id: "openai/gpt-4o-mini",
    providerId: "openrouter",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-4o mini (OpenRouter)",
    tags: ["openrouter", "openai-compatible", "cheap"],
    capabilities: CAPS_OPENROUTER_CHAT,
    pricing: PRICING_OR_GPT_4O_MINI,
    vendorIds: { firstParty: "openai/gpt-4o-mini" },
  })
  registerModel({
    id: "anthropic/claude-3.5-sonnet",
    providerId: "openrouter",
    surfaceId: "openai-chat-completions",
    displayName: "Claude 3.5 Sonnet (OpenRouter)",
    tags: ["openrouter", "openai-compatible"],
    capabilities: CAPS_OPENROUTER_CHAT,
    pricing: PRICING_OR_CLAUDE_35_SONNET,
    vendorIds: { firstParty: "anthropic/claude-3.5-sonnet" },
  })
  return ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"]
}

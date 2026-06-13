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

import { makeCharRatioEstimator } from "@minimal-agent/plugin-api/llm/token-estimate"

import { registerModel } from "../../src/llm/model-registry.ts"

import { CAPS_OPENROUTER_CHAT } from "./capabilities.ts"
import { PRICING_OR_CLAUDE_35_SONNET, PRICING_OR_GPT_4O_MINI } from "./pricing.ts"

/**
 * Token estimator for OpenRouter. OpenRouter proxies many upstream models
 * (OpenAI, Anthropic, others) on the OpenAI Chat wire, so no single
 * tokenizer applies. ~3.8 chars/token splits the difference between the
 * Anthropic (~3.5) and OpenAI (~4) families for a defensible estimate.
 */
const estimateOpenRouterTokens = makeCharRatioEstimator(3.8)

/** Populate the registry with a representative OpenRouter catalog. */
export function registerOpenRouterModels(): string[] {
  registerModel({
    id: "openai/gpt-4o-mini",
    providerId: "openrouter",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-4o mini (OpenRouter)",
    tags: ["openrouter", "openai-compatible", "cheap"],
    capabilities: CAPS_OPENROUTER_CHAT,
    estimateTokens: estimateOpenRouterTokens,
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
    estimateTokens: estimateOpenRouterTokens,
    pricing: PRICING_OR_CLAUDE_35_SONNET,
    vendorIds: { firstParty: "anthropic/claude-3.5-sonnet" },
  })
  return ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"]
}

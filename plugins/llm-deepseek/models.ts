/**
 * DeepSeek model registry entries.
 *
 * `deepseek-chat` registers on the SHARED `openai-chat` surface — the
 * DeepSeek adapter reuses `llm-openai`'s Chat Completions wire layer, so
 * the canonical request/response handling is identical; only the endpoint
 * differs.
 *
 * @module llm/providers/deepseek/models
 */

import { registerModel } from "../../src/llm/model-registry.ts"
import { CAPS_DEEPSEEK_CHAT } from "./capabilities.ts"
import { PRICING_DEEPSEEK_CHAT } from "./pricing.ts"

/** Populate the canonical registry with the DeepSeek catalog. Returns the ids. */
export function registerDeepSeekModels(): string[] {
  registerModel({
    id: "deepseek-chat",
    providerId: "deepseek",
    surfaceId: "openai-chat",
    displayName: "DeepSeek Chat (V3)",
    knowledgeCutoff: "2024-07",
    tags: ["deepseek", "chat", "openai-compatible"],
    capabilities: CAPS_DEEPSEEK_CHAT,
    pricing: PRICING_DEEPSEEK_CHAT,
    vendorIds: { firstParty: "deepseek-chat" },
  })
  return ["deepseek-chat"]
}

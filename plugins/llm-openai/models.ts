/**
 * OpenAI model registry entries.
 *
 * Mirrors the codex `models.json` flagship catalog (the gpt-5.x family,
 * led by `gpt-5.5`) plus the established gpt-4o / o-series on their
 * capability tables in `capabilities.ts`.
 *
 * Dual-surface models (reachable on BOTH Chat Completions and the
 * Responses API) are registered TWICE, under distinct ids with different
 * `surfaceId`s. `vendorIds.firstParty` always carries the REAL OpenAI
 * model id sent on the wire, so the `-chat` alias resolves to the same
 * upstream model. `adapter.run()` dispatches by `surfaceId`.
 *
 * @module llm/providers/openai/models
 */

import { registerModel } from "../../src/llm/model-registry.ts"

import {
  CAPS_GPT_4O_CHAT,
  CAPS_GPT_4O_MINI_CHAT,
  CAPS_GPT_5_5_CHAT,
  CAPS_GPT_5_5_RESPONSES,
  CAPS_GPT_5_RESPONSES,
  CAPS_GPT_41_CHAT,
  CAPS_O3_RESPONSES,
  CAPS_O4_MINI_RESPONSES,
} from "./capabilities.ts"
import {
  PRICING_GPT_4O,
  PRICING_GPT_4O_MINI,
  PRICING_GPT_5,
  PRICING_GPT_5_5,
  PRICING_GPT_41,
  PRICING_O3,
  PRICING_O4_MINI,
} from "./pricing.ts"

/**
 * Populate the canonical model registry with the OpenAI catalog.
 * Idempotent (last-write-wins). Returns the registered ids for tests.
 */
export function registerOpenAIModels(): string[] {
  // GPT-5.5 — flagship. Responses is the preferred surface; the `-chat`
  // id targets Chat Completions. Both send model id "gpt-5.5".
  registerModel({
    id: "gpt-5.5",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5.5",
    knowledgeCutoff: "2025-12",
    tags: ["gpt-5", "flagship", "reasoning", "production"],
    capabilities: CAPS_GPT_5_5_RESPONSES,
    pricing: PRICING_GPT_5_5,
    vendorIds: { firstParty: "gpt-5.5" },
  })
  registerModel({
    id: "gpt-5.5-chat",
    providerId: "openai",
    surfaceId: "openai-chat",
    displayName: "GPT-5.5 (Chat Completions)",
    knowledgeCutoff: "2025-12",
    tags: ["gpt-5", "flagship", "chat"],
    capabilities: CAPS_GPT_5_5_CHAT,
    pricing: PRICING_GPT_5_5,
    vendorIds: { firstParty: "gpt-5.5" },
  })

  // GPT-5 (Responses surface).
  registerModel({
    id: "gpt-5",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "GPT-5",
    tags: ["gpt-5", "reasoning"],
    capabilities: CAPS_GPT_5_RESPONSES,
    pricing: PRICING_GPT_5,
    vendorIds: { firstParty: "gpt-5" },
  })

  // o-series reasoning models (Responses surface, visible reasoning).
  registerModel({
    id: "o3",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "OpenAI o3",
    tags: ["o-series", "reasoning"],
    capabilities: CAPS_O3_RESPONSES,
    pricing: PRICING_O3,
    vendorIds: { firstParty: "o3" },
  })
  registerModel({
    id: "o4-mini",
    providerId: "openai",
    surfaceId: "openai-responses",
    displayName: "OpenAI o4-mini",
    tags: ["o-series", "reasoning", "fast"],
    capabilities: CAPS_O4_MINI_RESPONSES,
    pricing: PRICING_O4_MINI,
    vendorIds: { firstParty: "o4-mini" },
  })

  // gpt-4 family (Chat Completions surface).
  registerModel({
    id: "gpt-4.1",
    providerId: "openai",
    surfaceId: "openai-chat",
    displayName: "GPT-4.1",
    tags: ["gpt-4", "chat", "long-context"],
    capabilities: CAPS_GPT_41_CHAT,
    pricing: PRICING_GPT_41,
    vendorIds: { firstParty: "gpt-4.1" },
  })
  registerModel({
    id: "gpt-4o",
    providerId: "openai",
    surfaceId: "openai-chat",
    displayName: "GPT-4o",
    tags: ["gpt-4", "chat", "multimodal"],
    capabilities: CAPS_GPT_4O_CHAT,
    pricing: PRICING_GPT_4O,
    vendorIds: { firstParty: "gpt-4o" },
  })
  registerModel({
    id: "gpt-4o-mini",
    providerId: "openai",
    surfaceId: "openai-chat",
    displayName: "GPT-4o mini",
    tags: ["gpt-4", "chat", "fast", "cheap"],
    capabilities: CAPS_GPT_4O_MINI_CHAT,
    pricing: PRICING_GPT_4O_MINI,
    vendorIds: { firstParty: "gpt-4o-mini" },
  })

  return ["gpt-5.5", "gpt-5.5-chat", "gpt-5", "o3", "o4-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini"]
}

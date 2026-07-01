/**
 * HuggingFace model registry entries.
 *
 * HuggingFace Inference Providers uses namespaced model ids
 * (`openai/gpt-oss-120b`, `deepseek-ai/DeepSeek-V3`, etc.) with an
 * optional `:provider` suffix for backend selection. All register on
 * the `openai-chat-completions` surface — HuggingFace normalizes every
 * upstream model to the OpenAI Chat Completions wire format.
 *
 * A representative few are registered; any other HuggingFace model id
 * still works on the wire (the CLI doesn't gate on the registry), just
 * without a local cost estimate.
 *
 * @module llm/providers/huggingface/models
 */

import type {
  ModelRegistrar,
  ProviderModelSpec,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
import { makeCharRatioEstimator } from "@minimal-agent/plugin-api/llm/token-estimate"

import { registerModel } from "../../src/llm/model-registry.ts"

import { CAPS_HUGGINGFACE_CHAT } from "./capabilities.ts"
import {
  PRICING_HF_DEEPSEEK_V3,
  PRICING_HF_GENERIC,
  PRICING_HF_GPT_OSS_120B,
  PRICING_HF_QWEN3_32B,
} from "./pricing.ts"

/**
 * Token estimator for HuggingFace. HuggingFace proxies many upstream
 * models on the OpenAI Chat wire, so no single tokenizer applies.
 * ~3.8 chars/token splits the difference between Anthropic (~3.5) and
 * OpenAI (~4) families.
 */
const estimateHuggingFaceTokens = makeCharRatioEstimator(3.8)

/**
 * Populate the canonical model registry with the HuggingFace catalog.
 * Idempotent (last-write-wins). Returns the registered ids for tests.
 *
 * Registry seam (Wave D): when the host passes a {@link ModelRegistrar}
 * (the `models:register` capability), the catalog is contributed through
 * `ctx.models.register` — no `src/` import needed. When no registrar is
 * supplied (the legacy no-arg activation path), it falls back to the
 * imported `registerModel`.
 *
 * @param registrar - Optional host model registrar; defaults to the direct import.
 * @returns The registered model ids.
 */
export function registerHuggingFaceModels(registrar?: ModelRegistrar): string[] {
  const register = (spec: ProviderModelSpec): void => {
    if (registrar) registrar.register(spec)
    else registerModel(spec as Parameters<typeof registerModel>[0])
  }

  // openai/gpt-oss-120b — flagship open-weights model
  register({
    id: "openai/gpt-oss-120b",
    providerId: "huggingface",
    surfaceId: "openai-chat-completions",
    displayName: "GPT-OSS 120B (HuggingFace)",
    tags: ["huggingface", "openai-compatible", "flagship"],
    capabilities: CAPS_HUGGINGFACE_CHAT,
    estimateTokens: estimateHuggingFaceTokens,
    pricing: PRICING_HF_GPT_OSS_120B,
    vendorIds: { firstParty: "openai/gpt-oss-120b" },
  })

  // deepseek-ai/DeepSeek-V3
  register({
    id: "deepseek-ai/DeepSeek-V3",
    providerId: "huggingface",
    surfaceId: "openai-chat-completions",
    displayName: "DeepSeek V3 (HuggingFace)",
    tags: ["huggingface", "openai-compatible", "reasoning"],
    capabilities: CAPS_HUGGINGFACE_CHAT,
    estimateTokens: estimateHuggingFaceTokens,
    pricing: PRICING_HF_DEEPSEEK_V3,
    vendorIds: { firstParty: "deepseek-ai/DeepSeek-V3" },
  })

  // Qwen/Qwen3-32B
  register({
    id: "Qwen/Qwen3-32B",
    providerId: "huggingface",
    surfaceId: "openai-chat-completions",
    displayName: "Qwen3 32B (HuggingFace)",
    tags: ["huggingface", "openai-compatible", "cheap"],
    capabilities: CAPS_HUGGINGFACE_CHAT,
    estimateTokens: estimateHuggingFaceTokens,
    pricing: PRICING_HF_QWEN3_32B,
    vendorIds: { firstParty: "Qwen/Qwen3-32B" },
  })

  return ["openai/gpt-oss-120b", "deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-32B"]
}

export interface HuggingFaceModelSpec {
  id: string
  displayName?: string
  tags?: string[]
  pricing?: typeof PRICING_HF_GENERIC
}

/**
 * Register a single HuggingFace slug. Used for the built-in catalog and
 * for ad-hoc upstream slugs that the static snapshot does not know yet.
 */
export function registerHuggingFaceModel(spec: HuggingFaceModelSpec): string {
  registerModel({
    id: spec.id,
    providerId: "huggingface",
    surfaceId: "openai-chat-completions",
    displayName: spec.displayName ?? spec.id,
    tags: spec.tags ?? ["huggingface", "openai-compatible"],
    capabilities: CAPS_HUGGINGFACE_CHAT,
    estimateTokens: estimateHuggingFaceTokens,
    pricing: spec.pricing ?? PRICING_HF_GENERIC,
    vendorIds: { firstParty: spec.id },
  })
  return spec.id
}

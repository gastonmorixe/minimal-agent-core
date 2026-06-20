/**
 * Wafer model registry entries.
 *
 * All models register on the `openai-chat-completions` surface because
 * Wafer is an OpenAI-compatible gateway. This plugin reuses `llm-openai`'s
 * wire layer (translator, validator, header builder) — the same reuse
 * pattern as `llm-openrouter`.
 *
 * Model IDs are the exact strings returned by `GET /v1/models` (e.g.
 * `"GLM-5.1"`, `"deepseek-v4-pro"`). The catalog is registered at plugin
 * activation time via `registerWaferModels()`.
 *
 * @module llm/providers/wafer/models
 */

import type {
  ModelRegistrar,
  ProviderModelSpec,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
import { makeCharRatioEstimator } from "@minimal-agent/plugin-api/llm/token-estimate"

import { registerModel } from "../../src/llm/model-registry.ts"

import {
  CAPS_DEEPSEEK_V4_FLASH,
  CAPS_DEEPSEEK_V4_PRO,
  CAPS_GLM_5_1,
  CAPS_GLM_5_2,
  CAPS_KIMI_K2_6,
  CAPS_KIMI_K2_7_CODE,
  CAPS_MINIMAX_M3,
  CAPS_QWEN3_5_397B,
  CAPS_QWEN3_6_35B,
  CAPS_QWEN3_7_MAX,
} from "./capabilities.ts"
import {
  PRICING_DEEPSEEK_V4_FLASH,
  PRICING_DEEPSEEK_V4_PRO,
  PRICING_GLM_5_1,
  PRICING_GLM_5_2,
  PRICING_KIMI_K2_6,
  PRICING_KIMI_K2_7_CODE,
  PRICING_MINIMAX_M3,
  PRICING_QWEN3_5_397B,
  PRICING_QWEN3_6_35B,
  PRICING_QWEN3_7_MAX,
  PRICING_WAFER_GENERIC,
} from "./pricing.ts"

/**
 * Token estimator for Wafer models. Wafer proxies many upstream model
 * families (GLM, Kimi, Qwen, DeepSeek, MiniMax), each with their own
 * tokenizer. ~3.8 chars/token splits the difference and gives a
 * defensible estimate for the status bar.
 */
const estimateWaferTokens = makeCharRatioEstimator(3.8)

export interface WaferModelSpec {
  id: string
  displayName?: string
  tags?: string[]
  pricing?: WaferPricing
}

/**
 * Pricing in cents-per-million (the shape Wafer's API returns).
 * Converted to USD-per-million when building the MTokRate.
 */
export interface WaferPricing {
  inputCentsPerMil: number
  outputCentsPerMil: number
  cacheReadCentsPerMil: number
}

/**
 * Built-in model catalog. Each entry is a model advertised by the live
 * `GET /v1/models` endpoint as of 2026-06-19.
 */
const BUILTIN_MODELS = [
  {
    id: "GLM-5.1",
    displayName: "GLM-5.1 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "balanced"],
    capabilities: CAPS_GLM_5_1,
    pricing: PRICING_GLM_5_1,
  },
  {
    id: "GLM-5.2",
    displayName: "GLM-5.2 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "1m-context"],
    capabilities: CAPS_GLM_5_2,
    pricing: PRICING_GLM_5_2,
  },
  {
    id: "Kimi-K2.6",
    displayName: "Kimi-K2.6 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "vision", "balanced"],
    capabilities: CAPS_KIMI_K2_6,
    pricing: PRICING_KIMI_K2_6,
  },
  {
    id: "Kimi-K2.7-Code",
    displayName: "Kimi-K2.7-Code (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "code"],
    capabilities: CAPS_KIMI_K2_7_CODE,
    pricing: PRICING_KIMI_K2_7_CODE,
  },
  {
    id: "Qwen3.5-397B-A17B",
    displayName: "Qwen3.5-397B (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "balanced"],
    capabilities: CAPS_QWEN3_5_397B,
    pricing: PRICING_QWEN3_5_397B,
  },
  {
    id: "Qwen3.6-35B-A3B",
    displayName: "Qwen3.6-35B (Wafer)",
    tags: ["wafer", "openai-compatible", "cheap"],
    capabilities: CAPS_QWEN3_6_35B,
    pricing: PRICING_QWEN3_6_35B,
  },
  {
    id: "qwen3.7-max",
    displayName: "Qwen3.7-Max (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "flagship"],
    capabilities: CAPS_QWEN3_7_MAX,
    pricing: PRICING_QWEN3_7_MAX,
  },
  {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "cheap", "scout"],
    capabilities: CAPS_DEEPSEEK_V4_FLASH,
    pricing: PRICING_DEEPSEEK_V4_FLASH,
  },
  {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "flagship", "deep"],
    capabilities: CAPS_DEEPSEEK_V4_PRO,
    pricing: PRICING_DEEPSEEK_V4_PRO,
  },
  {
    id: "MiniMax-M3",
    displayName: "MiniMax-M3 (Wafer)",
    tags: ["wafer", "openai-compatible", "reasoning", "1m-context"],
    capabilities: CAPS_MINIMAX_M3,
    pricing: PRICING_MINIMAX_M3,
  },
]

/**
 * Populate the registry with the full Wafer catalog. When `registrar` is
 * provided (via `ProviderSetupContext.models`), models are contributed through
 * the SDK seam (`ctx.models.register`) instead of importing `registerModel`
 * from `src/`. Without it (legacy no-arg path), falls back to the direct
 * import. Idempotent: safe to call multiple times.
 */
export function registerWaferModels(registrar?: ModelRegistrar): string[] {
  const register = (entry: ProviderModelSpec) => {
    if (registrar) {
      registrar.register(entry)
    } else {
      registerModel(entry as Parameters<typeof registerModel>[0])
    }
  }

  const ids: string[] = []
  for (const m of BUILTIN_MODELS) {
    register({
      id: m.id,
      providerId: "wafer",
      surfaceId: "openai-chat-completions",
      displayName: m.displayName,
      tags: m.tags,
      capabilities: m.capabilities,
      estimateTokens: estimateWaferTokens,
      pricing: m.pricing,
      vendorIds: { firstParty: m.id },
    })
    ids.push(m.id)
  }
  return ids
}

/**
 * Register a single Wafer model. Used for the built-in catalog and for
 * ad-hoc models that the static snapshot does not know yet. Supports
 * the same SDK-seam dual path as {@link registerWaferModels}.
 */
export function registerWaferModel(spec: WaferModelSpec, registrar?: ModelRegistrar): string {
  const builtin = BUILTIN_MODELS.find((m) => m.id === spec.id)
  const entry: ProviderModelSpec = {
    id: spec.id,
    providerId: "wafer",
    surfaceId: "openai-chat-completions",
    displayName: spec.displayName ?? spec.id,
    tags: spec.tags ?? ["wafer", "openai-compatible"],
    capabilities: builtin?.capabilities ?? CAPS_GLM_5_1,
    estimateTokens: estimateWaferTokens,
    pricing: builtin?.pricing ?? PRICING_WAFER_GENERIC,
    vendorIds: { firstParty: spec.id },
  }
  if (registrar) {
    registrar.register(entry)
  } else {
    registerModel(entry as Parameters<typeof registerModel>[0])
  }
  return spec.id
}

/**
 * OpenCode Go model registry entries.
 *
 * Dual-surface: OpenAI Chat Completions models (DeepSeek, GLM, Kimi, MiMo)
 * and Anthropic Messages models (MiniMax, Qwen) share the same provider id
 * but dispatch through their respective wire translators.
 *
 * Each model has its own `Capabilities` record and `MTokRate` — no buckets.
 *
 * @module llm/providers/opencode/models
 */

import type { Capabilities } from "@minimal-agent/plugin-api/llm/capabilities"
import type {
  ModelRegistrar,
  ProviderModelSpec,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
import { makeCharRatioEstimator } from "@minimal-agent/plugin-api/llm/token-estimate"

import { registerModel } from "../../src/llm/model-registry.ts"
import type { SurfaceId } from "../../src/llm/provider.ts"

import {
  CAPS_DEEPSEEK_V4_FLASH,
  CAPS_DEEPSEEK_V4_PRO,
  CAPS_GLM_5,
  CAPS_GLM_5_1,
  CAPS_GLM_5_2,
  CAPS_KIMI_K2_6,
  CAPS_KIMI_K2_7_CODE,
  CAPS_MIMO_V2_5,
  CAPS_MIMO_V2_5_PRO,
  CAPS_MINIMAX_M2_5,
  CAPS_MINIMAX_M2_7,
  CAPS_MINIMAX_M3,
  CAPS_QWEN3_6_PLUS,
  CAPS_QWEN3_7_MAX,
  CAPS_QWEN3_7_PLUS,
} from "./capabilities.ts"
import {
  PRICING_DEEPSEEK_V4_FLASH,
  PRICING_DEEPSEEK_V4_PRO,
  PRICING_GLM_5,
  PRICING_GLM_5_1,
  PRICING_GLM_5_2,
  PRICING_KIMI_K2_6,
  PRICING_KIMI_K2_7_CODE,
  PRICING_MIMO_V2_5,
  PRICING_MIMO_V2_5_PRO,
  PRICING_MINIMAX_M2_5,
  PRICING_MINIMAX_M2_7,
  PRICING_MINIMAX_M3,
  PRICING_QWEN3_6_PLUS,
  PRICING_QWEN3_7_MAX,
  PRICING_QWEN3_7_PLUS,
} from "./pricing.ts"

const estimateTokens = makeCharRatioEstimator(3.8)

interface OpencodeModelSpec extends ProviderModelSpec {
  surfaceId: SurfaceId
}

function makeSpec(
  id: string,
  opts: {
    displayName: string
    surfaceId: SurfaceId
    capabilities: Capabilities
    pricing: OpencodeModelSpec["pricing"]
    tags: string[]
  },
): OpencodeModelSpec {
  return {
    id,
    providerId: "opencode",
    surfaceId: opts.surfaceId,
    displayName: opts.displayName,
    tags: opts.tags,
    capabilities: opts.capabilities,
    estimateTokens,
    pricing: opts.pricing,
    vendorIds: { firstParty: id },
  }
}

type ModelSink = (spec: OpencodeModelSpec) => void

/**
 * Register a single OpenCode Go model slug. Used for the built-in catalog and
 * for ad-hoc upstream slugs that the static snapshot does not know yet.
 */
export function registerOpencodeModel(spec: OpencodeModelSpec): string {
  registerModel(spec as Parameters<typeof registerModel>[0])
  return spec.id
}

/**
 * Populate the registry with the full OpenCode Go model catalog. Idempotent:
 * safe to call multiple times (re-registration is last-write-wins).
 */
export function registerOpencodeModels(registrar?: ModelRegistrar): string[] {
  const register: ModelSink = registrar
    ? (spec) => registrar.register(spec)
    : (spec) => registerModel(spec as Parameters<typeof registerModel>[0])

  const models: OpencodeModelSpec[] = [
    // OpenAI Chat Completions surface
    makeSpec("deepseek-v4-pro", {
      displayName: "DeepSeek V4 Pro",
      tags: ["opencode", "openai-compatible", "deepseek"],
      capabilities: CAPS_DEEPSEEK_V4_PRO,
      pricing: PRICING_DEEPSEEK_V4_PRO,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("deepseek-v4-flash", {
      displayName: "DeepSeek V4 Flash",
      tags: ["opencode", "openai-compatible", "deepseek", "cheap"],
      capabilities: CAPS_DEEPSEEK_V4_FLASH,
      pricing: PRICING_DEEPSEEK_V4_FLASH,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("glm-5.2", {
      displayName: "GLM-5.2",
      tags: ["opencode", "openai-compatible", "glm"],
      capabilities: CAPS_GLM_5_2,
      pricing: PRICING_GLM_5_2,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("glm-5.1", {
      displayName: "GLM-5.1",
      tags: ["opencode", "openai-compatible", "glm"],
      capabilities: CAPS_GLM_5_1,
      pricing: PRICING_GLM_5_1,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("glm-5", {
      displayName: "GLM-5",
      tags: ["opencode", "openai-compatible", "glm"],
      capabilities: CAPS_GLM_5,
      pricing: PRICING_GLM_5,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("kimi-k2.7-code", {
      displayName: "Kimi K2.7 Code",
      tags: ["opencode", "openai-compatible", "kimi"],
      capabilities: CAPS_KIMI_K2_7_CODE,
      pricing: PRICING_KIMI_K2_7_CODE,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("kimi-k2.6", {
      displayName: "Kimi K2.6",
      tags: ["opencode", "openai-compatible", "kimi"],
      capabilities: CAPS_KIMI_K2_6,
      pricing: PRICING_KIMI_K2_6,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("mimo-v2.5", {
      displayName: "MiMo-V2.5",
      tags: ["opencode", "openai-compatible", "mimo"],
      capabilities: CAPS_MIMO_V2_5,
      pricing: PRICING_MIMO_V2_5,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("mimo-v2.5-pro", {
      displayName: "MiMo-V2.5-Pro",
      tags: ["opencode", "openai-compatible", "mimo"],
      capabilities: CAPS_MIMO_V2_5_PRO,
      pricing: PRICING_MIMO_V2_5_PRO,
      surfaceId: "openai-chat-completions",
    }),

    // Anthropic Messages surface
    makeSpec("minimax-m3", {
      displayName: "MiniMax M3",
      tags: ["opencode", "anthropic-compatible", "minimax"],
      capabilities: CAPS_MINIMAX_M3,
      pricing: PRICING_MINIMAX_M3,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("minimax-m2.7", {
      displayName: "MiniMax M2.7",
      tags: ["opencode", "anthropic-compatible", "minimax"],
      capabilities: CAPS_MINIMAX_M2_7,
      pricing: PRICING_MINIMAX_M2_7,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("minimax-m2.5", {
      displayName: "MiniMax M2.5",
      tags: ["opencode", "anthropic-compatible", "minimax"],
      capabilities: CAPS_MINIMAX_M2_5,
      pricing: PRICING_MINIMAX_M2_5,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.7-max", {
      displayName: "Qwen3.7 Max",
      tags: ["opencode", "anthropic-compatible", "qwen"],
      capabilities: CAPS_QWEN3_7_MAX,
      pricing: PRICING_QWEN3_7_MAX,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.7-plus", {
      displayName: "Qwen3.7 Plus",
      tags: ["opencode", "anthropic-compatible", "qwen"],
      capabilities: CAPS_QWEN3_7_PLUS,
      pricing: PRICING_QWEN3_7_PLUS,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.6-plus", {
      displayName: "Qwen3.6 Plus",
      tags: ["opencode", "anthropic-compatible", "qwen"],
      capabilities: CAPS_QWEN3_6_PLUS,
      pricing: PRICING_QWEN3_6_PLUS,
      surfaceId: "anthropic-messages",
    }),
  ]

  for (const spec of models) register(spec)

  return models.map((s) => s.id)
}

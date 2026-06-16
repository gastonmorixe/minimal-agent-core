/**
 * OpenCode Go model registry entries.
 *
 * Dual-surface: OpenAI Chat Completions models (DeepSeek, GLM, Kimi, MiMo)
 * and Anthropic Messages models (MiniMax, Qwen) share the same provider id
 * but dispatch through their respective wire translators.
 *
 * @module llm/providers/opencode/models
 */

import type { Capabilities } from "@minimal-agent/plugin-api/llm/capabilities"
import type {
  ModelRegistrar,
  ProviderModelSpec,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
import { makeCharRatioEstimator } from "@minimal-agent/plugin-api/llm/token-estimate"

import type { SurfaceId } from "../../src/llm/provider.ts"
import { registerModel } from "../../src/llm/model-registry.ts"

import {
  CAPS_OPENCODE_CHAT,
  CAPS_OPENCODE_CHAT_1M,
  CAPS_OPENCODE_MESSAGES,
  CAPS_OPENCODE_MESSAGES_1M,
} from "./capabilities.ts"
import { PRICING_OPENCODE_GENERIC } from "./pricing.ts"

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
    pricing: PRICING_OPENCODE_GENERIC,
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
      capabilities: CAPS_OPENCODE_CHAT_1M,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("deepseek-v4-flash", {
      displayName: "DeepSeek V4 Flash",
      tags: ["opencode", "openai-compatible", "deepseek", "cheap"],
      capabilities: CAPS_OPENCODE_CHAT_1M,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("glm-5.1", {
      displayName: "GLM-5.1",
      tags: ["opencode", "openai-compatible", "glm"],
      capabilities: CAPS_OPENCODE_CHAT,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("glm-5", {
      displayName: "GLM-5",
      tags: ["opencode", "openai-compatible", "glm"],
      capabilities: CAPS_OPENCODE_CHAT,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("kimi-k2.7", {
      displayName: "Kimi K2.7",
      tags: ["opencode", "openai-compatible", "kimi"],
      capabilities: CAPS_OPENCODE_CHAT_1M,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("kimi-k2.6", {
      displayName: "Kimi K2.6",
      tags: ["opencode", "openai-compatible", "kimi"],
      capabilities: CAPS_OPENCODE_CHAT_1M,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("mimo-v2.5", {
      displayName: "MiMo-V2.5",
      tags: ["opencode", "openai-compatible", "mimo"],
      capabilities: CAPS_OPENCODE_CHAT_1M,
      surfaceId: "openai-chat-completions",
    }),
    makeSpec("mimo-v2.5-pro", {
      displayName: "MiMo-V2.5-Pro",
      tags: ["opencode", "openai-compatible", "mimo"],
      capabilities: CAPS_OPENCODE_CHAT_1M,
      surfaceId: "openai-chat-completions",
    }),

    // Anthropic Messages surface
    makeSpec("minimax-m3", {
      displayName: "MiniMax M3",
      tags: ["opencode", "anthropic-compatible", "minimax"],
      capabilities: CAPS_OPENCODE_MESSAGES_1M,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("minimax-m2.7", {
      displayName: "MiniMax M2.7",
      tags: ["opencode", "anthropic-compatible", "minimax"],
      capabilities: CAPS_OPENCODE_MESSAGES_1M,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("minimax-m2.5", {
      displayName: "MiniMax M2.5",
      tags: ["opencode", "anthropic-compatible", "minimax"],
      capabilities: CAPS_OPENCODE_MESSAGES,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.7-max", {
      displayName: "Qwen3.7 Max",
      tags: ["opencode", "anthropic-compatible", "qwen"],
      capabilities: CAPS_OPENCODE_MESSAGES_1M,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.7-plus", {
      displayName: "Qwen3.7 Plus",
      tags: ["opencode", "anthropic-compatible", "qwen"],
      capabilities: CAPS_OPENCODE_MESSAGES_1M,
      surfaceId: "anthropic-messages",
    }),
    makeSpec("qwen3.6-plus", {
      displayName: "Qwen3.6 Plus",
      tags: ["opencode", "anthropic-compatible", "qwen"],
      capabilities: CAPS_OPENCODE_MESSAGES_1M,
      surfaceId: "anthropic-messages",
    }),
  ]

  for (const spec of models) register(spec)

  return models.map((s) => s.id)
}

/**
 * Per-model capability tables for OpenCode Go models.
 *
 * Two wire surfaces:
 * - **Chat**: OpenAI Chat Completions (`/v1/chat/completions`).
 *   Used by DeepSeek, GLM, Kimi, MiMo.
 * - **Messages**: Anthropic Messages (`/v1/messages`).
 *   Used by MiniMax, Qwen.
 *
 * Each model gets its own `Capabilities` record. No bucket presets.
 * Data sourced from opencode.ai/docs/go, the /v1/models endpoint,
 * OpenRouter, Artificial Analysis, and each model's official docs
 * (June 2026 snapshot).
 *
 * @module llm/providers/opencode/capabilities
 */

import { type Capabilities, defaultCapabilities } from "@minimal-agent/plugin-api/llm/capabilities"

// ---------------------------------------------------------------------------
// Shared sub-shapes
// ---------------------------------------------------------------------------

const CACHING_AUTO = {
  explicit: false,
  automatic: true,
  ttls: [] as const,
  minPrefixTokens: 1024,
  reportsCacheHits: true,
} as const

const TOOLS_FULL = {
  userDefined: true,
  parallel: true,
  fineGrainedStreaming: true,
  toolChoice: true,
  strictSchema: false,
} as const

/** Text-only. */
const M_TEXT = { image: false, audio: false, pdf: false, video: false } as const

/** Text + image. */
const M_TI = { image: true, audio: false, pdf: false, video: false } as const

/** Text + image + video. */
const M_TIV = { image: true, audio: false, pdf: false, video: true } as const

/** Text + image + video + audio (omnimodal). */
const M_TIVA = { image: true, audio: true, pdf: false, video: true } as const

// ---------------------------------------------------------------------------
// Chat-surface thinking helpers
// ---------------------------------------------------------------------------

/** Chat model with extended (budgeted), visible thinking, 3 effort levels. */
function chatThink3(
  levels: readonly ["low", "medium", "high"],
  df: "low" | "medium" | "high" = "medium",
) {
  return {
    thinking: { adaptive: false, extended: true, visible: true, interleaved: false } as const,
    effort: { levels, default: df } as const,
  }
}

/** Chat model with extended, visible thinking, 2 levels (high, max). */
function chatThink2High() {
  return {
    thinking: { adaptive: false, extended: true, visible: true, interleaved: false } as const,
    effort: { levels: ["medium", "high"] as const, default: "medium" as const },
  }
}

/** Chat model with forced-on single-effort thinking. */
function chatThinkForced() {
  return {
    thinking: { adaptive: false, extended: true, visible: true, interleaved: false } as const,
    effort: { levels: ["medium"] as const, default: "medium" as const },
  }
}

/** Chat model with thinking + instant mode. */
function chatThinkOrInstant() {
  return {
    thinking: { adaptive: false, extended: true, visible: true, interleaved: false } as const,
    effort: { levels: ["low", "medium"] as const, default: "medium" as const },
  }
}

/** Chat model with adaptive thinking. */
function chatThinkAdaptive() {
  return {
    thinking: { adaptive: true, extended: false, visible: true, interleaved: false } as const,
    effort: { levels: ["low", "medium", "high"] as const, default: "medium" as const },
  }
}

// ---------------------------------------------------------------------------
// Messages-surface thinking helper
// ---------------------------------------------------------------------------

/** Anthropic Messages model: adaptive, visible, interleaved, 3 levels. */
function msgThink() {
  return {
    thinking: { adaptive: true, extended: false, visible: true, interleaved: true } as const,
    effort: { levels: ["low", "medium", "high"] as const, default: "medium" as const },
  }
}

// ---------------------------------------------------------------------------
// Base capability builders (avoid repetitive spread)
// ---------------------------------------------------------------------------

function chatBase(
  ctx: number,
  maxOut: number,
  modalities: { image: boolean; audio: boolean; pdf: boolean; video: boolean },
) {
  return {
    ...defaultCapabilities(),
    contextWindow: ctx,
    maxOutputTokens: maxOut,
    maxOutputTokensBatch: null,
    acceptsTemperature: true,
    acceptsTopP: true,
    acceptsTopK: false,
    acceptsSeed: true,
    acceptsStopSequences: true,
    speedFast: false,
    caching: { ...CACHING_AUTO },
    tools: { ...TOOLS_FULL },
    midConversationSystem: true,
    structuredOutputs: true,
    assistantPrefill: false,
    modalities: { ...modalities },
    serverSideHistory: false,
    serverTools: [],
  }
}

function msgBase(
  ctx: number,
  maxOut: number,
  modalities: { image: boolean; audio: boolean; pdf: boolean; video: boolean },
) {
  return {
    ...defaultCapabilities(),
    contextWindow: ctx,
    maxOutputTokens: maxOut,
    maxOutputTokensBatch: null,
    acceptsTemperature: true,
    acceptsTopP: true,
    acceptsTopK: false,
    acceptsSeed: false,
    acceptsStopSequences: true,
    speedFast: false,
    caching: { ...CACHING_AUTO },
    tools: { ...TOOLS_FULL },
    midConversationSystem: true,
    structuredOutputs: true,
    assistantPrefill: false,
    modalities: { ...modalities },
    serverSideHistory: false,
    serverTools: [],
  }
}

// ===========================================================================
// OpenAI Chat Completions surface models
// ===========================================================================

/** DeepSeek V4 Pro — 1.6T/49B MoE, 1M ctx, 384K output, 3-tier thinking. */
export const CAPS_DEEPSEEK_V4_PRO: Capabilities = {
  ...chatBase(1_000_000, 384_000, M_TEXT),
  ...chatThink3(["low", "medium", "high"]),
}

/** DeepSeek V4 Flash — 284B/13B MoE, 1M ctx, 384K output, 3-tier thinking. */
export const CAPS_DEEPSEEK_V4_FLASH: Capabilities = {
  ...chatBase(1_000_000, 384_000, M_TEXT),
  ...chatThink3(["low", "medium", "high"]),
}

/** GLM-5.2 — 744B/40B MoE, 1M ctx, 131K output, dual thinking (high / max). */
export const CAPS_GLM_5_2: Capabilities = {
  ...chatBase(1_000_000, 131_072, M_TEXT),
  ...chatThink2High(),
}

/** GLM-5.1 — 754B/40B MoE, 200K ctx, 65K output, single thinking mode. */
export const CAPS_GLM_5_1: Capabilities = {
  ...chatBase(200_000, 65_535, M_TEXT),
  ...chatThinkForced(),
}

/** GLM-5 — earlier generation, ~128K ctx, ~65K output, single thinking mode. */
export const CAPS_GLM_5: Capabilities = {
  ...chatBase(128_000, 65_535, M_TEXT),
  ...chatThinkForced(),
}

/** Kimi K2.7 Code — 1T/32B MoE, 256K ctx, 32K output, forced-on thinking. */
export const CAPS_KIMI_K2_7_CODE: Capabilities = {
  ...chatBase(256_000, 32_768, M_TIV),
  ...chatThinkForced(),
}

/** Kimi K2.6 — 1T/32B MoE, 256K ctx, 65K output, thinking + instant modes. */
export const CAPS_KIMI_K2_6: Capabilities = {
  ...chatBase(256_000, 65_535, M_TIV),
  ...chatThinkOrInstant(),
}

/** MiMo V2.5 — 310B/15B MoE, 1M ctx, 131K output, omni-modal + thinking. */
export const CAPS_MIMO_V2_5: Capabilities = {
  ...chatBase(1_000_000, 131_072, M_TIVA),
  ...chatThinkAdaptive(),
}

/** MiMo V2.5 Pro — ~1T MoE, 1M ctx, 131K output, text-only + thinking. */
export const CAPS_MIMO_V2_5_PRO: Capabilities = {
  ...chatBase(1_000_000, 131_072, M_TEXT),
  ...chatThinkAdaptive(),
}

// ===========================================================================
// Anthropic Messages surface models
// ===========================================================================

/** MiniMax M3 — 1M ctx (min 512K), 16K output, text+image+video, thinking. */
export const CAPS_MINIMAX_M3: Capabilities = {
  ...msgBase(1_000_000, 16_384, M_TIV),
  ...msgThink(),
}

/** MiniMax M2.7 — 205K ctx, 131K output, text-only, extended thinking. */
export const CAPS_MINIMAX_M2_7: Capabilities = {
  ...msgBase(205_000, 131_072, M_TEXT),
  ...msgThink(),
}

/** MiniMax M2.5 — 205K ctx, 197K output, text-only, thinking. */
export const CAPS_MINIMAX_M2_5: Capabilities = {
  ...msgBase(205_000, 196_608, M_TEXT),
  ...msgThink(),
}

/** Qwen3.7 Max — proprietary, 1M ctx, 65K output, text-only, extended CoT. */
export const CAPS_QWEN3_7_MAX: Capabilities = {
  ...msgBase(1_000_000, 65_536, M_TEXT),
  ...msgThink(),
}

/** Qwen3.7 Plus — 1M ctx, 65K output, text+image+video, thinking. */
export const CAPS_QWEN3_7_PLUS: Capabilities = {
  ...msgBase(1_000_000, 65_536, M_TIV),
  ...msgThink(),
}

/** Qwen3.6 Plus — 1M ctx, 65K output, text+image, always-on CoT. */
export const CAPS_QWEN3_6_PLUS: Capabilities = {
  ...msgBase(1_000_000, 65_536, M_TI),
  ...msgThink(),
}

/**
 * Conservative fallback for ad-hoc / dynamically-discovered models
 * not in the built-in catalog. Chat surface, text+image, 128K ctx,
 * 16K output, thinking enabled (the floor for Go models).
 */
export const CAPS_OPENCODE_CHAT_FALLBACK: Capabilities = {
  ...chatBase(128_000, 16_384, M_TEXT),
  ...chatThinkForced(),
}

/**
 * Conservative fallback for ad-hoc Messages-surface models.
 * 128K ctx, 16K output, text-only, adaptive thinking.
 */
export const CAPS_OPENCODE_MESSAGES_FALLBACK: Capabilities = {
  ...msgBase(128_000, 16_384, M_TEXT),
  ...msgThink(),
}

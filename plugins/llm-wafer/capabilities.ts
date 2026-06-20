/**
 * Capability tables per Wafer model.
 *
 * Each model's capabilities are derived from the live `GET /v1/models`
 * response (the `wafer.capabilities` field) and mapped to the canonical
 * {@link Capabilities} shape.
 *
 * All models speak the OpenAI Chat Completions surface
 * (`"openai-chat-completions"`), so these capability records define the
 * settings the shared OpenAI wire layer should use for each model.
 *
 * @module llm/providers/wafer/capabilities
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

const MODALITIES_TEXT = {
  image: false,
  audio: false,
  pdf: false,
  video: false,
} as const

// ---------------------------------------------------------------------------
// GLM-5.1 — 202K context, reasoning with reasoning_content, tools + vision: no
// ---------------------------------------------------------------------------

export const CAPS_GLM_5_1: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 202_752,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// GLM-5.2 — 1,048,576 context, reasoning, tools, vision: no
// ---------------------------------------------------------------------------

export const CAPS_GLM_5_2: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_048_576,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// Kimi-K2.6 — 262K context, vision + tools + reasoning, ZDR
// ---------------------------------------------------------------------------

export const CAPS_KIMI_K2_6: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 262_144,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { image: true, audio: false, pdf: false, video: false },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// Kimi-K2.7-Code — 262K context, reasoning ALWAYS ON, coding-focused
// ---------------------------------------------------------------------------

export const CAPS_KIMI_K2_7_CODE: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 262_144,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// Qwen3.5-397B-A17B — 262K context, massive MoE, reasoning, tools
// ---------------------------------------------------------------------------

export const CAPS_QWEN3_5_397B: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 262_144,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// Qwen3.6-35B-A3B — 256K context, small MoE, cheap
// ---------------------------------------------------------------------------

export const CAPS_QWEN3_6_35B: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 256_000,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
  effort: { levels: [], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// Qwen3.7-Max — premium Qwen, 256K context
// ---------------------------------------------------------------------------

export const CAPS_QWEN3_7_MAX: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 256_000,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// DeepSeek V4 Flash — 1M context, cheap reasoning
// ---------------------------------------------------------------------------

export const CAPS_DEEPSEEK_V4_FLASH: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_000_000,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// DeepSeek V4 Pro — 1M context, flagship reasoning
// ---------------------------------------------------------------------------

export const CAPS_DEEPSEEK_V4_PRO: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_000_000,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

// ---------------------------------------------------------------------------
// MiniMax-M3 — 1M context, inline <think> reasoning
// ---------------------------------------------------------------------------

export const CAPS_MINIMAX_M3: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_048_576,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT },
  serverSideHistory: false,
  serverTools: [],
}

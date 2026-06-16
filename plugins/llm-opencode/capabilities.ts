/**
 * Capability tables for OpenCode Go models.
 *
 * Two surfaces:
 * - **Chat**: OpenAI Chat Completions format (`/v1/chat/completions`).
 *   Used by DeepSeek, GLM, Kimi, MiMo. No thinking, sampling-friendly.
 * - **Messages**: Anthropic Messages format (`/v1/messages`).
 *   Used by MiniMax, Qwen. Adaptive thinking visible, effort levels.
 *
 * @module llm/providers/opencode/capabilities
 */

import { type Capabilities, defaultCapabilities } from "@minimal-agent/plugin-api/llm/capabilities"

const CACHING_AUTO = {
  explicit: false,
  automatic: true,
  ttls: [] as const,
  minPrefixTokens: 1024,
  reportsCacheHits: true,
}

const TOOLS_FULL = {
  userDefined: true,
  parallel: true,
  fineGrainedStreaming: true,
  toolChoice: true,
  strictSchema: false,
}

const MODALITIES_TEXT_IMAGE = {
  image: true,
  audio: false,
  pdf: false,
  video: false,
}

const NO_THINKING = {
  adaptive: false,
  extended: false,
  visible: false,
  interleaved: false,
}

const ADAPTIVE_THINKING_VISIBLE = {
  adaptive: true,
  extended: false,
  visible: true,
  interleaved: true,
}

/** Generic OpenCode Go Chat capability (text + image in, sampling-friendly, no thinking). */
export const CAPS_OPENCODE_CHAT: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  maxOutputTokensBatch: null,
  thinking: NO_THINKING,
  effort: { levels: [], default: "medium" },
  acceptsTemperature: true,
  acceptsTopP: true,
  acceptsTopK: false,
  acceptsSeed: true,
  acceptsStopSequences: true,
  speedFast: false,
  caching: CACHING_AUTO,
  tools: TOOLS_FULL,
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: MODALITIES_TEXT_IMAGE,
  serverSideHistory: false,
  serverTools: [],
}

/** OpenCode Go Chat capability with 1M context window. */
export const CAPS_OPENCODE_CHAT_1M: Capabilities = {
  ...CAPS_OPENCODE_CHAT,
  contextWindow: 1_000_000,
}

/** Generic OpenCode Go Messages capability (adaptive thinking, effort levels). */
export const CAPS_OPENCODE_MESSAGES: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  maxOutputTokensBatch: null,
  thinking: ADAPTIVE_THINKING_VISIBLE,
  effort: { levels: ["low", "medium", "high"], default: "medium" },
  acceptsTemperature: true,
  acceptsTopP: true,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: true,
  speedFast: false,
  caching: CACHING_AUTO,
  tools: TOOLS_FULL,
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: MODALITIES_TEXT_IMAGE,
  serverSideHistory: false,
  serverTools: [],
}

/** OpenCode Go Messages capability with 1M context window. */
export const CAPS_OPENCODE_MESSAGES_1M: Capabilities = {
  ...CAPS_OPENCODE_MESSAGES,
  contextWindow: 1_000_000,
}

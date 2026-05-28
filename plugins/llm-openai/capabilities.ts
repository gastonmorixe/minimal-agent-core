/**
 * Capability tables per OpenAI model.
 *
 * Two surfaces:
 * - **chat**: Chat Completions API (`/v1/chat/completions`). Mature,
 *   used by every gpt-4 family member and o1/o3/o4-mini.
 * - **responses**: Responses API (`/v1/responses`). Preferred for
 *   gpt-5 family and the new reasoning models. Stateful via
 *   `previous_response_id`, surfaces `reasoning_summary` deltas.
 *
 * Capability fields specific to OpenAI:
 * - `tools.strictSchema = true` (OpenAI honors `strict:true`).
 * - `caching.automatic = true` (server caches the prefix without hints).
 * - `caching.explicit = false` (no `cache_control` markers).
 * - `thinking.adaptive` only on reasoning models AND Responses surface
 *   (Chat exposes `reasoning_effort` but doesn't stream reasoning back).
 *
 * @module llm/providers/openai/capabilities
 */

import type { Capabilities } from "../../src/llm/capabilities.ts"
import { defaultCapabilities } from "../../src/llm/capabilities.ts"

// ---------------------------------------------------------------------------
// Shared sub-shapes
// ---------------------------------------------------------------------------

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
  strictSchema: true,
}

const MODALITIES_TEXT_IMAGE = {
  image: true,
  audio: false,
  pdf: false,
  video: false,
}

const MODALITIES_TEXT_IMAGE_AUDIO = {
  image: true,
  audio: true,
  pdf: false,
  video: false,
}

// ---------------------------------------------------------------------------
// Chat Completions surface
// ---------------------------------------------------------------------------

/**
 * gpt-4o family on Chat Completions. The everyday workhorse.
 * Accepts sampling, no thinking, automatic prefix caching.
 */
export const CAPS_GPT_4O_CHAT: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  maxOutputTokensBatch: null,
  thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
  effort: { levels: [], default: "medium" },
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
  modalities: { ...MODALITIES_TEXT_IMAGE_AUDIO },
  serverSideHistory: false,
  serverTools: [],
}

/** gpt-4o-mini on Chat Completions. Cheap + fast. */
export const CAPS_GPT_4O_MINI_CHAT: Capabilities = {
  ...CAPS_GPT_4O_CHAT,
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  modalities: { ...MODALITIES_TEXT_IMAGE },
}

/** gpt-4.1 on Chat Completions. */
export const CAPS_GPT_41_CHAT: Capabilities = {
  ...CAPS_GPT_4O_CHAT,
  contextWindow: 1_000_000,
  maxOutputTokens: 32_768,
}

/**
 * o3 / o4-mini reasoning models on Chat Completions.
 * Accept `reasoning_effort` but no `temperature` / `top_p`.
 * Reasoning tokens billed but not streamed visibly.
 */
export const CAPS_O3_CHAT: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 200_000,
  maxOutputTokens: 100_000,
  maxOutputTokensBatch: null,
  thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  speedFast: false,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE },
  serverSideHistory: false,
  serverTools: [],
}

export const CAPS_O4_MINI_CHAT: Capabilities = { ...CAPS_O3_CHAT }

// ---------------------------------------------------------------------------
// Responses surface
// ---------------------------------------------------------------------------

/**
 * gpt-5 on the Responses API. Adaptive-like reasoning, visible reasoning
 * summary deltas, stateful via `previous_response_id`, server-side tools
 * (`web_search_preview`, `file_search`, `code_interpreter`, `computer_use`).
 */
export const CAPS_GPT_5_RESPONSES: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 400_000,
  maxOutputTokens: 200_000,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  speedFast: false,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE_AUDIO, pdf: true },
  serverSideHistory: true,
  serverTools: ["web_search", "file_search", "code_interpreter", "computer_use"],
}

/** gpt-5-thinking — same model id family, opt into deeper reasoning. */
export const CAPS_GPT_5_THINKING_RESPONSES: Capabilities = {
  ...CAPS_GPT_5_RESPONSES,
}

/** o3 on Responses. Same model behavior as Chat variant but with reasoning visibility. */
export const CAPS_O3_RESPONSES: Capabilities = {
  ...CAPS_O3_CHAT,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  serverSideHistory: true,
  serverTools: ["web_search", "file_search", "code_interpreter"],
}

/** o4-mini on Responses. */
export const CAPS_O4_MINI_RESPONSES: Capabilities = { ...CAPS_O3_RESPONSES }

// ---------------------------------------------------------------------------
// GPT-5.5 (flagship; Responses preferred, also reachable on Chat)
// ---------------------------------------------------------------------------

/**
 * GPT-5.5 on the Responses API. 1.05M context, 128K max output, adaptive
 * reasoning with visible summaries, effort `low|medium|high|xhigh`.
 *
 * Sourced from developers.openai.com/api/docs/models/gpt-5.5 (the live
 * 1,050,000 context + 128K output figures) and the codex `models.json`
 * slug `gpt-5.5` (reasoning levels, `input_modalities`, `prefer_websockets`,
 * `additional_speed_tiers`). Knowledge cutoff 2025-12. The OpenAI "fast"
 * speed tier (`additional_speed_tiers: ["fast"]`) is a vendor extension we
 * do not wire yet, so `speedFast` stays false (no silent wire field).
 */
export const CAPS_GPT_5_5_RESPONSES: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  maxOutputTokensBatch: null,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  effort: { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: false,
  speedFast: false,
  caching: { ...CACHING_AUTO },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE },
  serverSideHistory: true,
  serverTools: ["web_search", "file_search", "code_interpreter"],
}

/**
 * GPT-5.5 on Chat Completions. Same underlying model; `reasoning_effort`
 * is accepted but reasoning is NOT streamed back (no visible summaries),
 * and there is no server-side history or hosted tools on this surface.
 */
export const CAPS_GPT_5_5_CHAT: Capabilities = {
  ...CAPS_GPT_5_5_RESPONSES,
  thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
  serverSideHistory: false,
  serverTools: [],
}

/**
 * Capability table for OpenRouter models (OpenAI-Chat-compatible gateway).
 *
 * OpenRouter normalizes every upstream model to the OpenAI Chat
 * Completions wire format, so this plugin reuses `llm-openai`'s wire layer
 * (see `adapter.ts`). One permissive capability record covers the
 * registered slugs; per-model differences (context window, true
 * modalities) vary upstream and are best-effort here.
 *
 * @module llm/providers/openrouter/capabilities
 */

import { type Capabilities, defaultCapabilities } from "@minimal-agent/plugin-api/llm/capabilities"

/** Generic OpenRouter chat capability (text + image in, sampling-friendly). */
export const CAPS_OPENROUTER_CHAT: Capabilities = {
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
  caching: {
    explicit: false,
    automatic: true,
    ttls: [],
    minPrefixTokens: 1024,
    reportsCacheHits: true,
  },
  tools: {
    userDefined: true,
    parallel: true,
    fineGrainedStreaming: true,
    toolChoice: true,
    strictSchema: false,
  },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { image: true, audio: false, pdf: false, video: false },
  serverSideHistory: false,
  serverTools: [],
}

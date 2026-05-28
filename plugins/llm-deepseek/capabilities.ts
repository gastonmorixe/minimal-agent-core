/**
 * Capability table for DeepSeek (OpenAI-Chat-compatible).
 *
 * DeepSeek speaks the OpenAI Chat Completions wire format, so this plugin
 * reuses `llm-openai`'s request-body builder + SSE translator + validator
 * wholesale (see `adapter.ts`). Only the model catalog, capabilities,
 * pricing, and endpoint are DeepSeek-specific.
 *
 * Figures are best-effort (refresh from api-docs.deepseek.com).
 *
 * @module llm/providers/deepseek/capabilities
 */

import type { Capabilities } from "../../src/llm/capabilities.ts"
import { defaultCapabilities } from "../../src/llm/capabilities.ts"

/** deepseek-chat (DeepSeek-V3): non-reasoning, sampling-friendly, automatic cache. */
export const CAPS_DEEPSEEK_CHAT: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 128_000,
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
  caching: { explicit: false, automatic: true, ttls: [], minPrefixTokens: 1024, reportsCacheHits: true },
  tools: {
    userDefined: true,
    parallel: true,
    fineGrainedStreaming: true,
    toolChoice: true,
    strictSchema: false,
  },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: true,
  modalities: { image: false, audio: false, pdf: false, video: false },
  serverSideHistory: false,
  serverTools: [],
}

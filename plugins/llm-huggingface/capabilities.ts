/**
 * Capability tables for HuggingFace Inference Providers.
 *
 * HuggingFace is a gateway that proxies to multiple backend providers.
 * The actual capabilities depend on the backend provider + model, so
 * these are conservative defaults. Only the Chat Completions surface
 * is wired; the Responses API is not yet supported by this adapter.
 *
 * @module llm/providers/huggingface/capabilities
 */

import { type Capabilities, defaultCapabilities } from "@minimal-agent/plugin-api/llm/capabilities"

/**
 * Generic HuggingFace Chat Completions capability. Conservative:
 * text + image in, sampling-friendly, tools supported, no thinking
 * streaming (backend-dependent).
 */
export const CAPS_HUGGINGFACE_CHAT: Capabilities = {
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

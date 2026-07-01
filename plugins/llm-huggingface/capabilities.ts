/**
 * Capability tables for HuggingFace Inference Providers.
 *
 * HuggingFace is a gateway that proxies to 13+ backend providers, so the real
 * capability set is per-model AND per-backend. Two layers here:
 *
 * 1. {@link CAPS_HUGGINGFACE_CHAT} — a PERMISSIVE default for the Chat
 *    Completions surface. HuggingFace's router gracefully IGNORES unsupported
 *    parameters (verified live: `reasoning_effort` on a non-reasoning model
 *    returns 200 and is dropped), so the correct posture for a gateway is to
 *    declare the superset and let the router handle per-model reality, rather
 *    than hard-rejecting valid requests. In particular reasoning is enabled:
 *    HF Chat accepts `reasoning_effort` (low/medium/high/xhigh) and streams
 *    `reasoning_content` back, which the reused llm-openai translator already
 *    maps to thinking blocks. The old table left `effort.levels: []` +
 *    `thinking.adaptive: false`, which hard-rejected `--effort` and
 *    `--thinking` on every reasoning model (DeepSeek-V4, gpt-oss, GLM, Qwen3
 *    thinking, ...).
 *
 * 2. {@link deriveHuggingFaceCapabilities} — builds EXACT caps for one model
 *    from its live `/v1/models` entry (context window, tools, structured
 *    outputs, image modality), OR-ing the boolean capabilities across the
 *    model's backend providers (a capability true on ANY backend is reachable
 *    by pinning `model:provider`). Reasoning stays permissive because the HF
 *    API exposes no reasoning/effort field at all.
 *
 * The Responses surface is not yet wired (Chat only).
 *
 * @module llm/providers/huggingface/capabilities
 */

import { type Capabilities, defaultCapabilities } from "@minimal-agent/plugin-api/llm/capabilities"

/**
 * Reasoning-effort levels HuggingFace's Chat Completions surface accepts
 * (per the chat-completion task spec; honored per-model, ignored otherwise).
 * `none`/`minimal` from the spec are dropped here because the core
 * `EffortLevel` union is low|medium|high|xhigh|max.
 */
const HF_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const

/**
 * Generic HuggingFace Chat Completions capability — the permissive gateway
 * default. Reasoning is ON (effort levels populated + adaptive/visible
 * thinking) because the router forwards `reasoning_effort` and streams
 * `reasoning_content`; non-reasoning backends ignore it gracefully. Modalities
 * default to text+image (image is stripped via the degrade path for text-only
 * models); `deriveHuggingFaceCapabilities` narrows this per-model when the live
 * catalog is available.
 */
export const CAPS_HUGGINGFACE_CHAT: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  maxOutputTokensBatch: null,
  // HF Chat surface: models reason via reasoning_effort and stream
  // reasoning_content back (mapped to thinking blocks by the reused OpenAI
  // translator). Adaptive + visible; no explicit token-budget (extended) knob.
  thinking: { adaptive: true, extended: false, visible: true, interleaved: false },
  effort: { levels: [...HF_EFFORT_LEVELS], default: "medium" },
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

/** One backend-provider entry from a `/v1/models` model object. */
export interface HuggingFaceProviderEntry {
  provider?: string
  status?: string
  context_length?: number
  supports_tools?: boolean
  supports_structured_output?: boolean
}

/** The capability-bearing slice of one `/v1/models` `data[]` model object. */
export interface HuggingFaceModelCapabilityInfo {
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
  providers?: HuggingFaceProviderEntry[]
}

/**
 * Derive EXACT capabilities for one model from its live `/v1/models` entry.
 *
 * Booleans (`tools`, `structuredOutputs`) are OR-ed across the model's backend
 * providers: a capability offered by ANY backend is reachable by pinning
 * `model:provider`, so the model-level cap is the union. `contextWindow` takes
 * the MAX advertised across providers (the largest window the model can be run
 * with). Image input comes from model-level `architecture.input_modalities`.
 * Reasoning stays permissive (HF exposes no reasoning field), so effort +
 * thinking are inherited from {@link CAPS_HUGGINGFACE_CHAT}.
 *
 * Absent capability keys are NOT treated as `false` alone — a stub backend
 * that omits `supports_tools` simply doesn't contribute a `true`; the OR over
 * all providers decides. When the entry carries no usable data, the permissive
 * default is returned unchanged.
 */
export function deriveHuggingFaceCapabilities(info: HuggingFaceModelCapabilityInfo): Capabilities {
  const providers = info.providers ?? []
  const liveProviders = providers.filter((p) => p.status === undefined || p.status === "live")
  const pool = liveProviders.length > 0 ? liveProviders : providers

  const anyTools = pool.some((p) => p.supports_tools === true)
  const anyStructured = pool.some((p) => p.supports_structured_output === true)
  const maxCtx = pool.reduce<number>(
    (max, p) =>
      typeof p.context_length === "number" && p.context_length > max ? p.context_length : max,
    0,
  )

  const inputModalities = info.architecture?.input_modalities ?? []
  const hasImage = inputModalities.includes("image")

  return {
    ...CAPS_HUGGINGFACE_CHAT,
    contextWindow: maxCtx > 0 ? maxCtx : CAPS_HUGGINGFACE_CHAT.contextWindow,
    tools: { ...CAPS_HUGGINGFACE_CHAT.tools, userDefined: anyTools },
    structuredOutputs: anyStructured,
    modalities: { ...CAPS_HUGGINGFACE_CHAT.modalities, image: hasImage },
  }
}

/**
 * Capability tables per Anthropic model.
 *
 * Source of truth: cli.patched.cjs gates at L116443+ + L116685+
 * (`vGH`, `EGH`, `qh9`, `PH6`, `NA_`, `Pj`, `VcH`, `YW`, `JH6`) and
 * the embedded Anthropic skill at L713970 that lists feature
 * availability per model. Exception: CAPS_FABLE_5 post-dates that
 * capture; it is derived from the live `GET /v1/models?beta=true`
 * record of 2026-06-09 plus A/B request probes (see
 * docs/changes/2026-06-09-anthropic-fable-5.md), not the cjs gates.
 *
 * Each export is a complete `Capabilities` record so the registry
 * entries in `models.ts` stay declarative.
 *
 * @module llm/providers/anthropic/capabilities
 */

import type { Capabilities } from "@minimal-agent/plugin-api/llm/capabilities"
import { defaultCapabilities } from "@minimal-agent/plugin-api/llm/capabilities"

// ---------------------------------------------------------------------------
// Shared sub-shapes
// ---------------------------------------------------------------------------

const ADAPTIVE_THINKING_VISIBLE = {
  adaptive: true,
  extended: false,
  visible: true,
  interleaved: true,
} as const

const EXTENDED_THINKING_VISIBLE = {
  adaptive: false,
  extended: true,
  visible: true,
  interleaved: true,
} as const

const NO_THINKING = {
  adaptive: false,
  extended: false,
  visible: false,
  interleaved: false,
} as const

const CACHING_FULL = {
  explicit: true,
  automatic: false,
  ttls: ["5m", "1h"] as const,
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

const TOOLS_BASIC = {
  userDefined: true,
  parallel: true,
  fineGrainedStreaming: false,
  toolChoice: true,
  strictSchema: false,
}

const MODALITIES_TEXT_IMAGE_PDF = {
  image: true,
  audio: false,
  pdf: true,
  video: false,
}

const MODALITIES_TEXT_IMAGE = {
  image: true,
  audio: false,
  pdf: false,
  video: false,
}

const SERVER_TOOLS_FULL = ["web_search", "code_interpreter"] as const
const SERVER_TOOLS_BASIC = ["web_search"] as const

// ---------------------------------------------------------------------------
// Opus 4.7 / 4.8 (adaptive-only, full feature set)
// ---------------------------------------------------------------------------

/**
 * Opus 4.8 capabilities. Mirrors 4.7 with no breaking changes; the
 * difference is behavioral (better tool triggering, better compaction).
 *
 * Verified against the live 2026-05-28 capture:
 *   - `temperature/top_p/top_k` all 400 → acceptsTemperature/topP/topK = false
 *   - `thinking:{type:"enabled", budget_tokens}` 400 → extended = false
 *   - `effort` default "high"; "xhigh" supported on opus 4.7+
 *   - `mid-conversation-system-2026-04-07` accepted
 *   - `extended-cache-ttl-2025-04-11` accepted (1h cache)
 *   - `fast-mode-2026-02-01` accepted; speedFast = true
 */
export const CAPS_OPUS_48: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  maxOutputTokensBatch: 300_000,
  thinking: { ...ADAPTIVE_THINKING_VISIBLE },
  effort: { levels: ["low", "medium", "high", "xhigh", "max"], default: "high" },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: true,
  speedFast: true,
  caching: { ...CACHING_FULL },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE_PDF },
  serverSideHistory: false,
  serverTools: [...SERVER_TOOLS_FULL],
}

/** Opus 4.7 — identical request surface to 4.8 (the announcement). */
export const CAPS_OPUS_47: Capabilities = { ...CAPS_OPUS_48 }

/**
 * Claude Fable 5 (`claude-fable-5`) — public Mythos-class model, launched
 * 2026-06-09. Request surface is identical to Opus 4.8 per the live
 * `GET /v1/models?beta=true` capability record:
 *   - max_input_tokens 1_000_000, max_tokens 128_000
 *   - effort low/medium/high/xhigh/max
 *   - thinking: adaptive supported, enabled(extended) NOT supported
 *   - image_input + pdf_input, structured_outputs, code_execution, batch
 * The one deliberate difference from Opus 4.8: Fable ships a single flat
 * rate with no `speed:"fast"` tier, so `speedFast` is false (no fast
 * pricing picker in `models.ts`).
 */
export const CAPS_FABLE_5: Capabilities = {
  ...CAPS_OPUS_48,
  speedFast: false,
}

// ---------------------------------------------------------------------------
// Opus 4.6 (transition tier — extended thinking still functional)
// ---------------------------------------------------------------------------

export const CAPS_OPUS_46: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  maxOutputTokensBatch: 300_000,
  thinking: { adaptive: true, extended: true, visible: true, interleaved: true },
  effort: { levels: ["low", "medium", "high", "max"], default: "high" },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: true,
  speedFast: true,
  caching: { ...CACHING_FULL },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE_PDF },
  serverSideHistory: false,
  serverTools: [...SERVER_TOOLS_FULL],
}

// ---------------------------------------------------------------------------
// Sonnet 5 (most-agentic Sonnet; adaptive thinking, effort incl. xhigh)
// ---------------------------------------------------------------------------

/**
 * Claude Sonnet 5 (`claude-sonnet-5`), launched 2026-06-30. Positioned as
 * the most agentic Sonnet, with performance close to Opus 4.8 at lower cost
 * (https://www.anthropic.com/news/claude-sonnet-5).
 *
 * Request surface mirrors Sonnet 4.6 (1M-native context, adaptive-only
 * thinking, no `speed:"fast"` tier, image + pdf input, structured outputs,
 * full tools + caching) with one documented difference: the launch
 * cost-performance charts plot Sonnet 5 at an `xhigh` effort level, so the
 * effort ladder gains `xhigh` over Sonnet 4.6's `low|medium|high`. The
 * default stays `medium` (the Sonnet-family default); callers opt up to
 * `high`/`xhigh` for harder agentic work. The model also ships an updated
 * tokenizer (≈1.0-1.35x token expansion vs Sonnet 4.6), which the
 * introductory pricing offsets to stay roughly cost-neutral.
 */
export const CAPS_SONNET_5: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  maxOutputTokensBatch: 300_000,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  effort: { levels: ["low", "medium", "high", "xhigh"], default: "medium" },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: true,
  speedFast: false,
  caching: { ...CACHING_FULL },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE_PDF },
  serverSideHistory: false,
  serverTools: [...SERVER_TOOLS_FULL],
}

// ---------------------------------------------------------------------------
// Sonnet 4.6 (effort-supporting, no fast mode, no xhigh)
// ---------------------------------------------------------------------------

export const CAPS_SONNET_46: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  maxOutputTokensBatch: 300_000,
  thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
  effort: { levels: ["low", "medium", "high"], default: "medium" },
  acceptsTemperature: false,
  acceptsTopP: false,
  acceptsTopK: false,
  acceptsSeed: false,
  acceptsStopSequences: true,
  speedFast: false,
  caching: { ...CACHING_FULL },
  tools: { ...TOOLS_FULL },
  midConversationSystem: true,
  structuredOutputs: true,
  assistantPrefill: false,
  modalities: { ...MODALITIES_TEXT_IMAGE_PDF },
  serverSideHistory: false,
  serverTools: [...SERVER_TOOLS_FULL],
}

// ---------------------------------------------------------------------------
// Sonnet 4.5 (extended-thinking with budget; no effort, no adaptive)
// ---------------------------------------------------------------------------

export const CAPS_SONNET_45: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  maxOutputTokensBatch: null,
  thinking: { ...EXTENDED_THINKING_VISIBLE },
  effort: { levels: [], default: "medium" },
  acceptsTemperature: true,
  acceptsTopP: true,
  acceptsTopK: true,
  acceptsSeed: false,
  acceptsStopSequences: true,
  speedFast: false,
  caching: {
    explicit: true,
    automatic: false,
    ttls: ["5m"],
    minPrefixTokens: 1024,
    reportsCacheHits: true,
  },
  tools: { ...TOOLS_BASIC },
  midConversationSystem: false,
  structuredOutputs: true,
  assistantPrefill: true,
  modalities: { ...MODALITIES_TEXT_IMAGE_PDF },
  serverSideHistory: false,
  serverTools: [...SERVER_TOOLS_BASIC],
}

// ---------------------------------------------------------------------------
// Haiku 4.5 (no thinking, no effort, fast & cheap)
// ---------------------------------------------------------------------------

export const CAPS_HAIKU_45: Capabilities = {
  ...defaultCapabilities(),
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  maxOutputTokensBatch: null,
  thinking: { ...NO_THINKING },
  effort: { levels: [], default: "medium" },
  acceptsTemperature: true,
  acceptsTopP: true,
  acceptsTopK: true,
  acceptsSeed: false,
  acceptsStopSequences: true,
  speedFast: false,
  caching: {
    explicit: true,
    automatic: false,
    ttls: ["5m"],
    // Haiku-family cache-eligibility floor is 2048 tokens (vs 1024 on
    // sonnet/opus) per the documented API minimums; was wrongly 1024
    // here while src/cache.ts hardcoded the correct 2048 by id regex.
    // The capability is now the single source (cache.ts reads it).
    minPrefixTokens: 2048,
    reportsCacheHits: true,
  },
  tools: { ...TOOLS_BASIC },
  midConversationSystem: false,
  structuredOutputs: true,
  assistantPrefill: true,
  modalities: { ...MODALITIES_TEXT_IMAGE },
  serverSideHistory: false,
  serverTools: [...SERVER_TOOLS_BASIC],
}

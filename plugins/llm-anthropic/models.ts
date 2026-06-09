/**
 * Anthropic model registry entries.
 *
 * Calling `registerAnthropicModels()` populates the canonical model
 * registry with every model in the live Anthropic catalog as of
 * 2026-06-09 (incl. `claude-fable-5`). Pricing comes from the typed
 * tables in `pricing.ts`;
 * capabilities come from `capabilities.ts`. `[1m]` aliases let the
 * caller request 1M context explicitly even when the default already
 * exposes it.
 *
 * @module llm/providers/anthropic/models
 */

import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { registerModel } from "../../src/llm/model-registry.ts"
import {
  ANTHROPIC_FABLE_5,
  ANTHROPIC_HAIKU_45,
  ANTHROPIC_OPUS_4X_FAST_LEGACY,
  ANTHROPIC_OPUS_4X_STANDARD,
  ANTHROPIC_OPUS_48_FAST,
  ANTHROPIC_SONNET_STANDARD,
  type MTokRate,
} from "../../src/llm/pricing.ts"
import { makeCharRatioEstimator } from "../../src/llm/token-estimate.ts"

import {
  CAPS_FABLE_5,
  CAPS_HAIKU_45,
  CAPS_OPUS_46,
  CAPS_OPUS_47,
  CAPS_OPUS_48,
  CAPS_SONNET_45,
  CAPS_SONNET_46,
} from "./capabilities.ts"

// ---------------------------------------------------------------------------
// Per-model pricing pickers (handle speed:"fast" rate switch)
// ---------------------------------------------------------------------------

const opus48PricingFor = (req: CanonicalRequest): MTokRate =>
  req.speed === "fast" ? ANTHROPIC_OPUS_48_FAST : ANTHROPIC_OPUS_4X_STANDARD

const legacyOpusFastPricingFor = (req: CanonicalRequest): MTokRate =>
  req.speed === "fast" ? ANTHROPIC_OPUS_4X_FAST_LEGACY : ANTHROPIC_OPUS_4X_STANDARD

/**
 * Token estimator for Anthropic's tokenizer family. ~3.5 chars/token is the
 * ratio the live output-token estimate in `src/client.ts` already uses, so
 * estimated session totals stay consistent with the live footer. Shared by
 * every Anthropic model entry.
 */
const estimateAnthropicTokens = makeCharRatioEstimator(3.5)

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

/**
 * Populate the canonical model registry with the current Anthropic
 * catalog. Idempotent : safe to call multiple times (re-registration
 * is last-write-wins).
 *
 * Returns the registered ids for testability.
 */
export function registerAnthropicModels(): string[] {
  registerModel({
    id: "claude-fable-5",
    aliases: ["claude-fable-5[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Fable 5",
    knowledgeCutoff: "2026-01",
    tags: ["fable", "mythos", "1m-context", "flagship", "production"],
    capabilities: CAPS_FABLE_5,
    estimateTokens: estimateAnthropicTokens,
    // Fable ships a single flat rate (no speed:"fast" tier), so no
    // pricingForRequest picker : the base `pricing` always applies.
    pricing: ANTHROPIC_FABLE_5,
    vendorIds: {
      firstParty: "claude-fable-5",
      bedrock: "us.anthropic.claude-fable-5",
      vertex: "claude-fable-5",
      foundry: "claude-fable-5",
      anthropicAws: "claude-fable-5",
      mantle: "anthropic.claude-fable-5",
      gateway: "claude-fable-5",
    },
  })

  registerModel({
    id: "claude-opus-4-8",
    aliases: ["claude-opus-4-8[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Opus 4.8",
    knowledgeCutoff: "2026-01",
    tags: ["opus", "1m-context", "flagship", "production"],
    capabilities: CAPS_OPUS_48,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_OPUS_4X_STANDARD,
    pricingForRequest: opus48PricingFor,
    vendorIds: {
      firstParty: "claude-opus-4-8",
      bedrock: "us.anthropic.claude-opus-4-8",
      vertex: "claude-opus-4-8",
      foundry: "claude-opus-4-8",
      anthropicAws: "claude-opus-4-8",
      mantle: "anthropic.claude-opus-4-8",
      gateway: "claude-opus-4-8",
    },
  })

  registerModel({
    id: "claude-opus-4-7",
    aliases: ["claude-opus-4-7[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Opus 4.7",
    knowledgeCutoff: "2026-01",
    tags: ["opus", "1m-context", "production"],
    capabilities: CAPS_OPUS_47,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_OPUS_4X_STANDARD,
    pricingForRequest: legacyOpusFastPricingFor,
    vendorIds: {
      firstParty: "claude-opus-4-7",
      bedrock: "us.anthropic.claude-opus-4-7",
      vertex: "claude-opus-4-7",
      foundry: "claude-opus-4-7",
      anthropicAws: "claude-opus-4-7",
      mantle: "anthropic.claude-opus-4-7",
      gateway: "claude-opus-4-7",
    },
  })

  registerModel({
    id: "claude-opus-4-6",
    aliases: ["claude-opus-4-6[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Opus 4.6",
    knowledgeCutoff: "2025-05",
    tags: ["opus", "1m-context", "legacy"],
    capabilities: CAPS_OPUS_46,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_OPUS_4X_STANDARD,
    pricingForRequest: legacyOpusFastPricingFor,
    vendorIds: {
      firstParty: "claude-opus-4-6",
      bedrock: "us.anthropic.claude-opus-4-6-v1",
      vertex: "claude-opus-4-6",
      foundry: "claude-opus-4-6",
      anthropicAws: "claude-opus-4-6",
      gateway: "claude-opus-4-6",
    },
  })

  registerModel({
    id: "claude-sonnet-4-6",
    aliases: ["claude-sonnet-4-6[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Sonnet 4.6",
    knowledgeCutoff: "2025-08",
    tags: ["sonnet", "1m-context", "production"],
    capabilities: CAPS_SONNET_46,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_SONNET_STANDARD,
    vendorIds: {
      firstParty: "claude-sonnet-4-6",
      bedrock: "us.anthropic.claude-sonnet-4-6",
      vertex: "claude-sonnet-4-6",
      foundry: "claude-sonnet-4-6",
      anthropicAws: "claude-sonnet-4-6",
      gateway: "claude-sonnet-4-6",
    },
  })

  registerModel({
    id: "claude-sonnet-4-5-20250929",
    aliases: ["claude-sonnet-4-5"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Sonnet 4.5",
    knowledgeCutoff: "2025-01",
    tags: ["sonnet", "legacy"],
    capabilities: CAPS_SONNET_45,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_SONNET_STANDARD,
    vendorIds: {
      firstParty: "claude-sonnet-4-5-20250929",
      bedrock: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      vertex: "claude-sonnet-4-5@20250929",
      foundry: "claude-sonnet-4-5",
      anthropicAws: "claude-sonnet-4-5-20250929",
      gateway: "claude-sonnet-4-5-20250929",
    },
  })

  registerModel({
    id: "claude-haiku-4-5-20251001",
    aliases: ["claude-haiku-4-5"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Haiku 4.5",
    knowledgeCutoff: "2025-02",
    tags: ["haiku", "fast", "production"],
    capabilities: CAPS_HAIKU_45,
    estimateTokens: estimateAnthropicTokens,
    pricing: ANTHROPIC_HAIKU_45,
    vendorIds: {
      firstParty: "claude-haiku-4-5-20251001",
      bedrock: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      vertex: "claude-haiku-4-5@20251001",
      foundry: "claude-haiku-4-5",
      anthropicAws: "claude-haiku-4-5-20251001",
      mantle: "anthropic.claude-haiku-4-5",
      gateway: "claude-haiku-4-5-20251001",
    },
  })

  return [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
  ]
}

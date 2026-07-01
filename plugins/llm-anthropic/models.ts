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

import type { Capabilities } from "@minimal-agent/plugin-api/llm/capabilities"
import type {
  ModelRegistrar,
  ProviderModelSpec,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
import { makeCharRatioEstimator } from "@minimal-agent/plugin-api/llm/token-estimate"

import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { registerModel } from "../../src/llm/model-registry.ts"
import type { MTokRate } from "../../src/llm/pricing.ts"

import {
  CAPS_FABLE_5,
  CAPS_HAIKU_45,
  CAPS_OPUS_46,
  CAPS_OPUS_47,
  CAPS_OPUS_48,
  CAPS_SONNET_5,
  CAPS_SONNET_45,
  CAPS_SONNET_46,
} from "./capabilities.ts"
import {
  ANTHROPIC_FABLE_5,
  ANTHROPIC_HAIKU_45,
  ANTHROPIC_OPUS_4X_FAST_LEGACY,
  ANTHROPIC_OPUS_4X_STANDARD,
  ANTHROPIC_OPUS_48_FAST,
  ANTHROPIC_SONNET_5_INTRO,
  ANTHROPIC_SONNET_STANDARD,
} from "./pricing.ts"

/**
 * The neutral {@link ProviderModelSpec} plus the optional per-request pricing
 * picker the Anthropic catalog needs (the `speed:"fast"` rate switch). It is a
 * subtype of `ProviderModelSpec`, so a spec built here registers through the
 * host {@link ModelRegistrar} unchanged; the picker rides along on the object
 * and the registry's `ModelEntry.pricingForRequest` slot consumes it.
 */
type AnthropicModelSpec = ProviderModelSpec & {
  pricingForRequest?: (req: CanonicalRequest) => MTokRate
}

// ---------------------------------------------------------------------------
// Per-model pricing pickers (handle speed:"fast" rate switch)
// ---------------------------------------------------------------------------

const opus48PricingFor = (req: CanonicalRequest): MTokRate =>
  req.speed === "fast" ? ANTHROPIC_OPUS_48_FAST : ANTHROPIC_OPUS_4X_STANDARD

const legacyOpusFastPricingFor = (req: CanonicalRequest): MTokRate =>
  req.speed === "fast" ? ANTHROPIC_OPUS_4X_FAST_LEGACY : ANTHROPIC_OPUS_4X_STANDARD

/**
 * First instant (UTC) at which Claude Sonnet 5 leaves introductory pricing.
 * The launch post promises intro rates "through August 31, 2026", so the
 * standard rate applies from 2026-09-01T00:00:00Z onward.
 */
const SONNET_5_STANDARD_PRICING_FROM = Date.UTC(2026, 8, 1) // month is 0-based: 8 = September

/**
 * Pure date-gated rate selector for Sonnet 5: the introductory $2/$10 rate
 * before the cutover, the standard $3/$15 rate on/after it. Exported for
 * unit testing so the boundary is pinned without mocking the clock.
 *
 * @param nowMs - epoch milliseconds to evaluate against (defaults to now).
 */
export function sonnet5RateForDate(nowMs: number = Date.now()): MTokRate {
  return nowMs < SONNET_5_STANDARD_PRICING_FROM
    ? ANTHROPIC_SONNET_5_INTRO
    : ANTHROPIC_SONNET_STANDARD
}

/**
 * Per-request pricing picker for Sonnet 5. Pricing depends on the wall clock
 * (intro vs standard), not the request shape, so the request is ignored; the
 * date gate lives in {@link sonnet5RateForDate}.
 */
const sonnet5PricingFor = (_req: CanonicalRequest): MTokRate => sonnet5RateForDate()

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
 * Registry seam (Wave D): when the host passes a {@link ModelRegistrar} (the
 * `models:register` capability, threaded through `register(ctx)`), the catalog
 * is contributed through `ctx.models.register` — no `src/` import needed. When
 * no registrar is supplied (the legacy no-arg activation path, or a direct call
 * in a test), it falls back to the imported `registerModel`. This lets the live
 * provider-loader adopt the ctx-driven path provider-by-provider without
 * breaking the no-context callers.
 *
 * @param registrar - Optional host model registrar; defaults to the direct import.
 * @returns the registered ids for testability.
 */
export function registerAnthropicModels(registrar?: ModelRegistrar): string[] {
  // Single registration sink: the host registrar when present, else the
  // direct registry import (back-compat fallback). The fallback cast bridges
  // the contract's plain-string `surfaceId` to the host's `SurfaceId` union;
  // the literals below are valid surface ids either way. The local spec type
  // widens `ProviderModelSpec` with the optional `pricingForRequest` picker
  // (the speed:"fast" rate switch the Anthropic catalog needs but the neutral
  // contract omits); it stays assignable to `ProviderModelSpec`, and the host
  // registrar/`registerModel` both carry the picker through unchanged.
  const register = (spec: AnthropicModelSpec): void => {
    if (registrar) registrar.register(spec)
    else registerModel(spec as Parameters<typeof registerModel>[0])
  }
  register({
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

  register({
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

  register({
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

  register({
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

  register({
    id: "claude-sonnet-5",
    aliases: ["claude-sonnet-5[1m]"],
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: "Claude Sonnet 5",
    knowledgeCutoff: "2026-01",
    tags: ["sonnet", "1m-context", "flagship", "production"],
    capabilities: CAPS_SONNET_5,
    estimateTokens: estimateAnthropicTokens,
    // Base rate is the introductory $2/$10; the date-gated picker swaps to
    // the $3/$15 standard rate on 2026-09-01 (see sonnet5PricingFor).
    pricing: ANTHROPIC_SONNET_5_INTRO,
    pricingForRequest: sonnet5PricingFor,
    vendorIds: {
      firstParty: "claude-sonnet-5",
      bedrock: "us.anthropic.claude-sonnet-5",
      vertex: "claude-sonnet-5",
      foundry: "claude-sonnet-5",
      anthropicAws: "claude-sonnet-5",
      mantle: "anthropic.claude-sonnet-5",
      gateway: "claude-sonnet-5",
    },
  })

  register({
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

  register({
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

  register({
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
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
  ]
}

// ---------------------------------------------------------------------------
// Ad-hoc registration (unknown / not-yet-cataloged Claude ids)
// ---------------------------------------------------------------------------

/**
 * Family-default profile for an unknown Claude id: the capability table and
 * base pricing to assume. Each maps to an EXISTING, tested table so an ad-hoc
 * model behaves like the closest known sibling of its family rather than a
 * generic guess. The default rung is the latest production member of the
 * family (e.g. a future `claude-opus-4-9` inherits Opus 4.8's surface).
 */
interface FamilyDefault {
  capabilities: Capabilities
  pricing: MTokRate
  tags: ReadonlyArray<string>
}

/**
 * Infer the {@link FamilyDefault} for an arbitrary Claude id by family token.
 * Order matters only in that each branch is mutually exclusive on the family
 * word. Falls back to the Sonnet profile (the mid-tier, most-common default)
 * for an id that names no recognized family. The returned tables are the same
 * objects the static catalog uses, so ad-hoc models stay consistent with their
 * cataloged siblings and cost accounting is as accurate as the family allows.
 */
function familyDefaultFor(modelId: string): FamilyDefault {
  if (modelId.includes("opus")) {
    return {
      capabilities: CAPS_OPUS_48,
      pricing: ANTHROPIC_OPUS_4X_STANDARD,
      tags: ["opus", "adhoc"],
    }
  }
  if (modelId.includes("haiku")) {
    return { capabilities: CAPS_HAIKU_45, pricing: ANTHROPIC_HAIKU_45, tags: ["haiku", "adhoc"] }
  }
  if (modelId.includes("fable") || modelId.includes("mythos")) {
    return { capabilities: CAPS_FABLE_5, pricing: ANTHROPIC_FABLE_5, tags: ["fable", "adhoc"] }
  }
  // Default + explicit "sonnet": assume the current Sonnet-class surface.
  return {
    capabilities: CAPS_SONNET_5,
    pricing: ANTHROPIC_SONNET_5_INTRO,
    tags: ["sonnet", "adhoc"],
  }
}

/**
 * Register a synthetic entry for a Claude id the static catalog does not know
 * yet (e.g. a brand-new SKU announced after this build). The host calls this
 * via {@link ProviderPlugin.registerAdHocModel} when a `--model <id>` selection
 * misses the registry, so an as-yet-uncataloged Claude model boots with the
 * capability + pricing profile of its closest known family sibling instead of
 * hard-failing with "unknown model".
 *
 * Idempotent (last-write-wins). Marked with an `adhoc` tag and a `displayName`
 * suffix so it is visibly distinct from a first-class cataloged entry. Pricing
 * is a best-effort family default and may not match the real SKU rate; a model
 * that warrants accurate accounting should get a real catalog entry.
 *
 * @param registrar - The host model registrar (captured at activation).
 * @param modelId - The unknown Claude id to synthesize.
 * @returns the registered id, for testability.
 */
export function registerAnthropicAdHocModelInto(
  registrar: ModelRegistrar,
  modelId: string,
): string {
  // Strip a client-side [1m] suffix for the canonical id; re-add as alias when
  // present so `--model claude-foo[1m]` still resolves to the bare entry.
  const bare = modelId.replace(/\[1m\]$/i, "")
  const wants1m = bare !== modelId
  const { capabilities, pricing, tags } = familyDefaultFor(bare)
  registrar.register({
    id: bare,
    aliases: wants1m ? [`${bare}[1m]`] : undefined,
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    displayName: `${bare} (ad-hoc)`,
    capabilities,
    pricing,
    estimateTokens: estimateAnthropicTokens,
    tags: [...tags],
    vendorIds: { firstParty: bare },
  })
  return bare
}

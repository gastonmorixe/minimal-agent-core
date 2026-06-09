/**
 * Pricing model + cost calculation. Provider-neutral.
 *
 * Per-1M-token rates plus a per-call rate for server-side tools
 * (web_search). Matches the structure of Anthropic's `Fp` / `cx1` /
 * `dx1` tables (see `private/research/2026-05-28-llm-providers/00-research-notes.md`)
 * and OpenAI's pricing pages.
 *
 * @module llm/pricing
 */

import type { CanonicalUsage } from "./canonical-events.ts"

/**
 * USD-per-million-tokens for each token category, plus per-call
 * surcharges for billable server-tool calls.
 *
 * `cacheWriteUSD` is what the provider charges to *create* a cache
 * entry (higher than input). `cacheReadUSD` is what you pay on a hit
 * (much lower than input).
 *
 * All values are USD; the calculator multiplies by `tokens / 1e6`.
 */
export interface MTokRate {
  inputUSD: number
  outputUSD: number
  cacheWriteUSD: number
  cacheReadUSD: number
  /** Per-call USD for server-side web_search invocations. */
  webSearchPerCallUSD: number
  /** Optional surcharge for reasoning tokens, if billed separately. */
  reasoningUSD?: number
}

/**
 * Cost breakdown returned by {@link calculateUsageCost}.
 */
export interface UsageCost {
  inputUSD: number
  outputUSD: number
  cacheReadUSD: number
  cacheCreationUSD: number
  reasoningUSD: number
  webSearchUSD: number
  totalUSD: number
}

/**
 * Compute USD cost of one `CanonicalUsage` snapshot at the given rate.
 * Unreported fields are treated as zero.
 */
export function calculateUsageCost(usage: CanonicalUsage, rate: MTokRate): UsageCost {
  const inputUSD = (usage.inputTokens / 1_000_000) * rate.inputUSD
  const outputUSD = (usage.outputTokens / 1_000_000) * rate.outputUSD
  const cacheReadUSD = ((usage.cacheReadTokens ?? 0) / 1_000_000) * rate.cacheReadUSD
  const cacheCreationUSD = ((usage.cacheCreationTokens ?? 0) / 1_000_000) * rate.cacheWriteUSD
  const reasoningUSD =
    rate.reasoningUSD !== undefined
      ? ((usage.reasoningTokens ?? 0) / 1_000_000) * rate.reasoningUSD
      : 0
  const webSearchUSD = (usage.webSearchRequests ?? 0) * rate.webSearchPerCallUSD
  const totalUSD =
    inputUSD + outputUSD + cacheReadUSD + cacheCreationUSD + reasoningUSD + webSearchUSD
  return {
    inputUSD,
    outputUSD,
    cacheReadUSD,
    cacheCreationUSD,
    reasoningUSD,
    webSearchUSD,
    totalUSD,
  }
}

/**
 * Merge two usage snapshots additively. Adapter-side helper for
 * accumulating mid-stream usage updates without losing reported fields.
 */
export function mergeUsage(a: CanonicalUsage, b: CanonicalUsage): CanonicalUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: sumDefined(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: sumDefined(a.cacheCreationTokens, b.cacheCreationTokens),
    cacheBreakdown: mergeBreakdown(a.cacheBreakdown, b.cacheBreakdown),
    reasoningTokens: sumDefined(a.reasoningTokens, b.reasoningTokens),
    webSearchRequests: sumDefined(a.webSearchRequests, b.webSearchRequests),
  }
}

function sumDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined
  return (a ?? 0) + (b ?? 0)
}

function mergeBreakdown(
  a: CanonicalUsage["cacheBreakdown"],
  b: CanonicalUsage["cacheBreakdown"],
): CanonicalUsage["cacheBreakdown"] {
  if (!a && !b) return undefined
  return {
    fiveMinute: sumDefined(a?.fiveMinute, b?.fiveMinute),
    oneHour: sumDefined(a?.oneHour, b?.oneHour),
  }
}

// ---------------------------------------------------------------------------
// Known rate tables (well-known shared tiers)
// ---------------------------------------------------------------------------

/**
 * Anthropic's `Fp` rate : opus 4.5 / 4.6 / 4.7 / 4.8 standard pricing.
 * Verified against `cli.patched.cjs` L116516 in claude-code 2.1.154.
 */
export const ANTHROPIC_OPUS_4X_STANDARD: MTokRate = {
  inputUSD: 5,
  outputUSD: 25,
  cacheWriteUSD: 6.25,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0.01,
}

/**
 * Anthropic's `cx1` rate : opus 4.8 with `speed:"fast"`. 2× standard.
 * Verified against `cli.patched.cjs` L116530.
 */
export const ANTHROPIC_OPUS_48_FAST: MTokRate = {
  inputUSD: 10,
  outputUSD: 50,
  cacheWriteUSD: 12.5,
  cacheReadUSD: 1,
  webSearchPerCallUSD: 0.01,
}

/**
 * Claude Fable 5 rate : the public Mythos-class model released 2026-06-09.
 * $10 / 1M input, $50 / 1M output (0.4x the gated Mythos Preview's $25/$125),
 * with the standard 1.25x cache-write / 0.1x cache-read multipliers. There is
 * no `speed:"fast"` tier for this model, so a single flat rate applies.
 * Numerically identical to ANTHROPIC_OPUS_48_FAST; kept as a separate table
 * because the two rates move independently (one is a fast-tier surcharge,
 * this is a base rate).
 */
export const ANTHROPIC_FABLE_5: MTokRate = {
  inputUSD: 10,
  outputUSD: 50,
  cacheWriteUSD: 12.5,
  cacheReadUSD: 1,
  webSearchPerCallUSD: 0.01,
}

/**
 * Anthropic's `dx1` rate : opus 4.5/4.6/4.7 with `speed:"fast"`. 6× standard.
 * Verified against `cli.patched.cjs` L116523.
 */
export const ANTHROPIC_OPUS_4X_FAST_LEGACY: MTokRate = {
  inputUSD: 30,
  outputUSD: 150,
  cacheWriteUSD: 37.5,
  cacheReadUSD: 3,
  webSearchPerCallUSD: 0.01,
}

/**
 * Anthropic's `vKH` rate : sonnet 3.5 / 3.7 / 4 / 4.5 / 4.6.
 */
export const ANTHROPIC_SONNET_STANDARD: MTokRate = {
  inputUSD: 3,
  outputUSD: 15,
  cacheWriteUSD: 3.75,
  cacheReadUSD: 0.3,
  webSearchPerCallUSD: 0.01,
}

/**
 * Anthropic's `l78` rate : haiku 4.5.
 */
export const ANTHROPIC_HAIKU_45: MTokRate = {
  inputUSD: 1,
  outputUSD: 5,
  cacheWriteUSD: 1.25,
  cacheReadUSD: 0.1,
  webSearchPerCallUSD: 0.01,
}

/**
 * Anthropic's `c78` rate : haiku 3.5.
 */
export const ANTHROPIC_HAIKU_35: MTokRate = {
  inputUSD: 0.8,
  outputUSD: 4,
  cacheWriteUSD: 1,
  cacheReadUSD: 0.08,
  webSearchPerCallUSD: 0.01,
}

/**
 * Anthropic's `_Y9` rate : opus 4.0 / 4.1 (legacy).
 */
export const ANTHROPIC_OPUS_40_41: MTokRate = {
  inputUSD: 15,
  outputUSD: 75,
  cacheWriteUSD: 18.75,
  cacheReadUSD: 1.5,
  webSearchPerCallUSD: 0.01,
}

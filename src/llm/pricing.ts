/**
 * Pricing model + cost calculation. Provider-neutral.
 *
 * Per-1M-token rates plus a per-call rate for server-side tools
 * (web_search). This module owns only the rate SHAPE and the cost
 * arithmetic; each provider plugin ships its own concrete rate tables
 * (see e.g. the per-provider pricing modules under plugins/).
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

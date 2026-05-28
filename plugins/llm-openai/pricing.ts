/**
 * OpenAI per-model pricing tables (USD per 1M tokens).
 *
 * Source: openai.com/pricing (as of 2026-05-28; refresh when stale).
 * `cacheReadUSD` matches OpenAI's `cached_input` tier (~25%-50% of
 * normal input depending on model).
 *
 * @module llm/providers/openai/pricing
 */

import type { MTokRate } from "../../src/llm/pricing.ts"

/** gpt-4o standard pricing. */
export const PRICING_GPT_4O: MTokRate = {
  inputUSD: 2.5,
  outputUSD: 10,
  cacheWriteUSD: 2.5,
  cacheReadUSD: 1.25,
  webSearchPerCallUSD: 0,
}

/** gpt-4o-mini standard pricing. */
export const PRICING_GPT_4O_MINI: MTokRate = {
  inputUSD: 0.15,
  outputUSD: 0.6,
  cacheWriteUSD: 0.15,
  cacheReadUSD: 0.075,
  webSearchPerCallUSD: 0,
}

/** gpt-4.1 pricing. */
export const PRICING_GPT_41: MTokRate = {
  inputUSD: 2,
  outputUSD: 8,
  cacheWriteUSD: 2,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}

/** o3 pricing. Reasoning tokens billed at output rate. */
export const PRICING_O3: MTokRate = {
  inputUSD: 2,
  outputUSD: 8,
  cacheWriteUSD: 2,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
  reasoningUSD: 8,
}

/** o4-mini pricing. */
export const PRICING_O4_MINI: MTokRate = {
  inputUSD: 1.1,
  outputUSD: 4.4,
  cacheWriteUSD: 1.1,
  cacheReadUSD: 0.275,
  webSearchPerCallUSD: 0,
  reasoningUSD: 4.4,
}

/** gpt-5 (Responses) pricing. */
export const PRICING_GPT_5: MTokRate = {
  inputUSD: 5,
  outputUSD: 20,
  cacheWriteUSD: 5,
  cacheReadUSD: 1.25,
  webSearchPerCallUSD: 0,
  reasoningUSD: 20,
}

/**
 * gpt-5.5 (Responses + Chat) pricing. $5 in / $30 out per MTok; cached
 * input $0.50. Source: developers.openai.com/api/docs/models/gpt-5.5
 * (2026-05-28). Note the output rate is $30, NOT $25 (Anthropic Opus 4.x).
 * OpenAI bills reasoning tokens at the output rate; automatic prefix
 * caching has no write fee, so `cacheWriteUSD` mirrors input and is never
 * exercised (OpenAI reports `cached_tokens` as reads only).
 */
export const PRICING_GPT_5_5: MTokRate = {
  inputUSD: 5,
  outputUSD: 30,
  cacheWriteUSD: 5,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
  reasoningUSD: 30,
}

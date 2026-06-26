/**
 * Anthropic per-model pricing tables (USD per 1M tokens).
 *
 * The rate DATA lives in this provider plugin; core keeps only the generic
 * {@link MTokRate} shape and the neutral `calculateUsageCost` / `mergeUsage`
 * arithmetic. Source: `cli.patched.cjs` L116516+ in claude-code 2.1.154 and
 * `private/research/2026-05-28-llm-providers/00-research-notes.md`.
 *
 * @module llm/providers/anthropic/pricing
 */

import type { MTokRate } from "../../src/llm/pricing.ts"

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

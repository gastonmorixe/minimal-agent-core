/**
 * OpenCode Go per-model pricing tables (USD per 1M tokens).
 *
 * OpenCode Go is a subscription ($5 first month, then $10/month) with
 * per-token rates that matter for the $12/5h, $30/week, $60/month usage
 * limits. We record the Go list prices so cost estimates reflect real
 * quota burn.
 *
 * Rates sourced from opencode.ai/docs/go (June 2026 snapshot).
 *
 * @module llm/providers/opencode/pricing
 */

import type { MTokRate } from "../../src/llm/pricing.ts"

/** Generic fallback for ad-hoc models not in the built-in catalog. */
export const PRICING_OPENCODE_GENERIC: MTokRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

// OpenAI Chat Completions surface

export const PRICING_DEEPSEEK_V4_PRO: MTokRate = {
  inputUSD: 1.74,
  outputUSD: 3.48,
  cacheWriteUSD: 0, // no explicit cache writes on Chat surface
  cacheReadUSD: 0.0145,
  webSearchPerCallUSD: 0,
}

export const PRICING_DEEPSEEK_V4_FLASH: MTokRate = {
  inputUSD: 0.14,
  outputUSD: 0.28,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.0028,
  webSearchPerCallUSD: 0,
}

export const PRICING_GLM_5_2: MTokRate = {
  inputUSD: 1.4,
  outputUSD: 4.4,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.26,
  webSearchPerCallUSD: 0,
}

export const PRICING_GLM_5_1: MTokRate = {
  inputUSD: 1.4,
  outputUSD: 4.4,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.26,
  webSearchPerCallUSD: 0,
}

export const PRICING_GLM_5: MTokRate = {
  ...PRICING_GLM_5_1, // same pricing tier
}

export const PRICING_KIMI_K2_7_CODE: MTokRate = {
  inputUSD: 0.95,
  outputUSD: 4.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.19,
  webSearchPerCallUSD: 0,
}

export const PRICING_KIMI_K2_6: MTokRate = {
  inputUSD: 0.95,
  outputUSD: 4.0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.16,
  webSearchPerCallUSD: 0,
}

export const PRICING_MIMO_V2_5: MTokRate = {
  inputUSD: 0.14,
  outputUSD: 0.28,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.0028,
  webSearchPerCallUSD: 0,
}

export const PRICING_MIMO_V2_5_PRO: MTokRate = {
  inputUSD: 1.74,
  outputUSD: 3.48,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.0145,
  webSearchPerCallUSD: 0,
}

// Anthropic Messages surface

export const PRICING_MINIMAX_M3: MTokRate = {
  inputUSD: 0.3,
  outputUSD: 1.2,
  cacheWriteUSD: 0,
  cacheReadUSD: 0.06,
  webSearchPerCallUSD: 0,
}

export const PRICING_MINIMAX_M2_7: MTokRate = {
  inputUSD: 0.3,
  outputUSD: 1.2,
  cacheWriteUSD: 0.375, // Messages surface supports cache writes
  cacheReadUSD: 0.06,
  webSearchPerCallUSD: 0,
}

export const PRICING_MINIMAX_M2_5: MTokRate = {
  inputUSD: 0.3,
  outputUSD: 1.2,
  cacheWriteUSD: 0.375,
  cacheReadUSD: 0.06,
  webSearchPerCallUSD: 0,
}

export const PRICING_QWEN3_7_MAX: MTokRate = {
  inputUSD: 2.5,
  outputUSD: 7.5,
  cacheWriteUSD: 3.125,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}

export const PRICING_QWEN3_7_PLUS: MTokRate = {
  inputUSD: 0.4, // ≤256K tier (covers most agent calls)
  outputUSD: 1.6,
  cacheWriteUSD: 0.5,
  cacheReadUSD: 0.04,
  webSearchPerCallUSD: 0,
}

export const PRICING_QWEN3_6_PLUS: MTokRate = {
  inputUSD: 0.5, // ≤256K tier
  outputUSD: 3.0,
  cacheWriteUSD: 0.625,
  cacheReadUSD: 0.05,
  webSearchPerCallUSD: 0,
}

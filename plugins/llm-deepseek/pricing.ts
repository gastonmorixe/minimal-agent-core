/**
 * DeepSeek pricing (USD per 1M tokens).
 *
 * Best-effort, refresh from api-docs.deepseek.com/quick_start/pricing.
 * `cacheReadUSD` is DeepSeek's cache-hit input tier.
 *
 * @module llm/providers/deepseek/pricing
 */

import type { MTokRate } from "../../src/llm/pricing.ts"

/** deepseek-chat standard pricing. */
export const PRICING_DEEPSEEK_CHAT: MTokRate = {
  inputUSD: 0.27,
  outputUSD: 1.1,
  cacheWriteUSD: 0.27,
  cacheReadUSD: 0.07,
  webSearchPerCallUSD: 0,
}

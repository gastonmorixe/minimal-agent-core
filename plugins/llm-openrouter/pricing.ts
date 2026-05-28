/**
 * OpenRouter pricing (USD per 1M tokens).
 *
 * OpenRouter passes through each upstream model's price; these are
 * best-effort snapshots for the registered slugs (refresh from
 * openrouter.ai/models). Models not registered here still work on the
 * wire (the CLI doesn't gate on the registry) but won't have a local
 * cost estimate.
 *
 * @module llm/providers/openrouter/pricing
 */

import type { MTokRate } from "../../src/llm/pricing.ts"

/** openai/gpt-4o-mini via OpenRouter. */
export const PRICING_OR_GPT_4O_MINI: MTokRate = {
  inputUSD: 0.15,
  outputUSD: 0.6,
  cacheWriteUSD: 0.15,
  cacheReadUSD: 0.075,
  webSearchPerCallUSD: 0,
}

/** anthropic/claude-3.5-sonnet via OpenRouter. */
export const PRICING_OR_CLAUDE_35_SONNET: MTokRate = {
  inputUSD: 3,
  outputUSD: 15,
  cacheWriteUSD: 3.75,
  cacheReadUSD: 0.3,
  webSearchPerCallUSD: 0,
}

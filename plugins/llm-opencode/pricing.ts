/**
 * OpenCode Go pricing (USD per 1M tokens).
 *
 * OpenCode Go is a flat-rate subscription ($5 first month, then $10/month).
 * Models registered here won't have a local per-token cost estimate since
 * billing is subscription-based rather than per-token.
 *
 * @module llm/providers/opencode/pricing
 */

import type { MTokRate } from "../../src/llm/pricing.ts"

/** Neutral placeholder for all OpenCode Go models (subscription-priced). */
export const PRICING_OPENCODE_GENERIC: MTokRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

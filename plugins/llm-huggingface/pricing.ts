/**
 * HuggingFace Inference Providers pricing (USD per 1M tokens).
 *
 * HuggingFace passes through each backend provider's pricing with no
 * markup. These are best-effort snapshots for the registered slugs;
 * actual pricing varies by backend provider. Models not registered
 * here still work on the wire but won't have a local cost estimate.
 *
 * @module llm/providers/huggingface/pricing
 */

import type { MTokRate } from "../../src/llm/pricing.ts"

/** Neutral placeholder for HuggingFace slugs without local pricing. */
export const PRICING_HF_GENERIC: MTokRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

/** openai/gpt-oss-120b via HuggingFace (representative pricing). */
export const PRICING_HF_GPT_OSS_120B: MTokRate = {
  inputUSD: 0.15,
  outputUSD: 0.6,
  cacheWriteUSD: 0.15,
  cacheReadUSD: 0.075,
  webSearchPerCallUSD: 0,
}

/** deepseek-ai/DeepSeek-V3 via HuggingFace (representative pricing). */
export const PRICING_HF_DEEPSEEK_V3: MTokRate = {
  inputUSD: 0.27,
  outputUSD: 1.1,
  cacheWriteUSD: 0.27,
  cacheReadUSD: 0.07,
  webSearchPerCallUSD: 0,
}

/** Qwen/Qwen3-32B via HuggingFace (representative pricing). */
export const PRICING_HF_QWEN3_32B: MTokRate = {
  inputUSD: 0.08,
  outputUSD: 0.28,
  cacheWriteUSD: 0.08,
  cacheReadUSD: 0.02,
  webSearchPerCallUSD: 0,
}

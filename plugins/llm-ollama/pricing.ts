/**
 * Pricing rates for Ollama Cloud models.
 *
 * Ollama Cloud is a subscription/usage service (ollama.com/pricing): it does
 * not publish stable per-1M-token rates per model the way first-party APIs do,
 * and billing is account-level rather than per-call. So the per-token USD rates
 * here are zero — the footer's session-cost readout shows token COUNTS (from
 * `eval_count` / `prompt_eval_count` usage) without a misleading dollar figure.
 * If Ollama publishes per-model rates later, swap these in per family.
 *
 * The shape matches the host's `ModelRate` (`@minimal-agent/plugin-api`
 * `ModelRate`), so a registered model carries a pricing object the cost
 * calculator can read without special-casing this provider.
 *
 * @module llm/providers/ollama/pricing
 */

import type { ModelRate } from "@minimal-agent/plugin-api/types/host-capabilities"

/**
 * Zero-rate pricing for an Ollama Cloud model. Token counts still surface in
 * the footer; the USD estimate is $0 because billing is subscription-based.
 */
export const PRICING_OLLAMA_GENERIC: ModelRate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

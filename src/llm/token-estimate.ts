/**
 * Provider-neutral token estimation — `src/` surface.
 *
 * Wave D-2 split: the PURE helpers (`makeCharRatioEstimator`,
 * `estimateTokensFromText`, `DEFAULT_CHARS_PER_TOKEN`, `TokenEstimator`) MOVED
 * to the leaf contract package `@minimal-agent/plugin-api/llm/token-estimate`
 * so a plugin's `models.ts` can build its per-model estimator without reaching
 * into `src/`. This module re-exports them, and keeps the one registry-bound
 * function {@link estimateTokensForModel} here — it calls `findModel` on the
 * live model registry (host state), which must not ship in a shared package.
 *
 * @module llm/token-estimate
 */

import { estimateTokensFromText } from "@minimal-agent/plugin-api/llm/token-estimate"

import { findModel, findModelForProvider } from "./model-registry.ts"

export * from "@minimal-agent/plugin-api/llm/token-estimate"

/**
 * Estimate the token count of `text` for a specific model, using that
 * model's registered {@link TokenEstimator} when available.
 *
 * Resolution order:
 *   1. `modelId` + `providerId` resolves to a provider-scoped entry with
 *      `estimateTokens` → use it (so same bare id under two providers gets
 *      the right tokenizer ratio).
 *   2. `modelId` resolves globally → use its estimator.
 *   3. Otherwise → `estimateTokensFromText` at the default ratio.
 *
 * An unknown / forward-compat model id (the CLI doesn't gate `--model` on the
 * registry) degrades to the default ratio rather than throwing, so listings
 * never blow up on a session recorded under a model we don't know.
 *
 * @param modelId - Canonical or alias model id. `undefined` ⇒ default ratio.
 * @param text - Text to estimate.
 * @param providerId - Optional provider scope for disambiguation.
 * @returns Estimated token count (always ≥ 0, integer).
 */
export function estimateTokensForModel(
  modelId: string | undefined,
  text: string,
  providerId?: string,
): number {
  if (modelId && providerId) {
    const scoped = findModelForProvider(modelId, providerId)
    if (scoped?.estimateTokens) return scoped.estimateTokens(text)
  }
  if (modelId) {
    const entry = findModel(modelId)
    if (entry?.estimateTokens) return entry.estimateTokens(text)
  }
  return estimateTokensFromText(text)
}

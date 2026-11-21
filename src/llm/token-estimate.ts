/**
 * Token estimation — `src/` surface (registry-bound lookup, no defaults).
 *
 * Token estimation is a provider-to-model decision. The provider plugin sets
 * `ModelEntry.estimateTokens` with the building blocks of
 * `@minimal-agent/core/plugin-api/llm/token-estimate` (re-exported here).
 * Core holds NO ratio and NO formula: when the (provider, model) pair has no
 * estimator, the lookup gives `undefined`, and each caller decides what to
 * show (usually nothing).
 *
 * @module llm/token-estimate
 */

import type { TokenEstimator } from "@minimal-agent/core/plugin-api/llm/token-estimate"

import { findModel, findModelForProvider } from "./model-registry.ts"

export * from "@minimal-agent/core/plugin-api/llm/token-estimate"

/**
 * The registered {@link TokenEstimator} of a model, or `undefined`.
 *
 * Resolution order:
 *   1. `modelId` + `providerId` resolves to a provider-scoped entry with
 *      `estimateTokens` → that estimator (the same bare id under two
 *      providers gets the estimator of the right provider).
 *   2. `modelId` resolves globally (id or alias) to an entry with
 *      `estimateTokens` → that estimator.
 *   3. Otherwise → `undefined`. There is NO fallback ratio.
 *
 * @param modelId - Canonical or alias model id. `undefined` gives `undefined`.
 * @param providerId - Optional provider scope.
 */
export function lookupTokenEstimator(
  modelId: string | undefined,
  providerId?: string,
): TokenEstimator | undefined {
  if (!modelId) return undefined
  if (providerId) {
    const scoped = findModelForProvider(modelId, providerId)
    if (scoped?.estimateTokens) return scoped.estimateTokens
  }
  return findModel(modelId)?.estimateTokens
}

/**
 * Estimate the token count of `text` with the estimator of the model (see
 * {@link lookupTokenEstimator}), or `undefined` when the model has none.
 * There is no fallback ratio: an unknown model has no estimate.
 *
 * @param modelId - Canonical or alias model id.
 * @param text - Text to estimate.
 * @param providerId - Optional provider scope.
 * @returns An integer, at least 0, or `undefined` when there is no estimator.
 */
export function estimateTokensForModel(
  modelId: string | undefined,
  text: string,
  providerId?: string,
): number | undefined {
  const estimator = lookupTokenEstimator(modelId, providerId)
  return estimator ? estimator(text) : undefined
}

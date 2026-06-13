/**
 * Provider-neutral token estimation.
 *
 * When a session never persisted billed `usage` (old sessions, crashes
 * before the first `message_delta`, providers that don't report usage), we
 * still want a "tokens this session" number for listings. The honest answer
 * is "we don't know exactly", so we estimate from text length using a
 * per-model-family chars-per-token ratio and mark the result as estimated.
 *
 * The estimator is intentionally dumb: `ceil(chars / ratio)`. Real
 * tokenizers (BPE) vary with content, but a single ratio is within ~10-15%
 * for prose/code, which is all a listing column needs. The point is to give
 * a defensible magnitude, not to reproduce the billing meter.
 *
 * `ModelEntry.estimateTokens` lets each provider override the ratio for its
 * tokenizer family (Anthropic ≈ 3.5, OpenAI cl100k/o200k ≈ 4). Callers that
 * have a `modelId` use {@link estimateTokensForModel}; callers without one
 * fall back to {@link DEFAULT_CHARS_PER_TOKEN}.
 *
 * @module llm/token-estimate
 */

import { findModel } from "./model-registry.ts"

/**
 * Fallback chars-per-token when no model-specific estimator is available.
 * 3.5 matches the heuristic already used in `src/client.ts` (live output
 * token estimate) and `src/cache.ts` (cache-eligibility threshold), so the
 * estimated and live numbers stay in the same ballpark.
 */
export const DEFAULT_CHARS_PER_TOKEN = 3.5

/**
 * A function that estimates the token count of a piece of text. This is the
 * shape stored on `ModelEntry.estimateTokens` (in `./model-registry.ts`).
 */
export type TokenEstimator = (text: string) => number

/**
 * Build a {@link TokenEstimator} from a fixed chars-per-token ratio.
 *
 * Each provider's `models.ts` calls this with its tokenizer-family ratio and
 * stores the result on every `ModelEntry.estimateTokens`. Keeping the factory
 * in core (rather than re-deriving the arithmetic in each plugin) is what
 * makes the estimate consistent and the wiring a one-liner per model.
 *
 * @param charsPerToken - Average characters per token for the family. Must be
 *   positive; non-positive or non-finite values fall back to
 *   {@link DEFAULT_CHARS_PER_TOKEN}.
 * @returns An estimator: `text => ceil(text.length / charsPerToken)`.
 */
export function makeCharRatioEstimator(charsPerToken: number): TokenEstimator {
  const ratio =
    Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN
  return (text: string): number => {
    if (!text) return 0
    return Math.ceil(text.length / ratio)
  }
}

/**
 * Estimate the token count of `text` using `charsPerToken` (defaults to
 * {@link DEFAULT_CHARS_PER_TOKEN}). Provider-neutral; no registry lookup.
 */
export function estimateTokensFromText(
  text: string,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  return makeCharRatioEstimator(charsPerToken)(text)
}

/**
 * Estimate the token count of `text` for a specific model, using that
 * model's registered {@link TokenEstimator} when available.
 *
 * Resolution order:
 *   1. `modelId` resolves to a registered entry with `estimateTokens` → use it.
 *   2. Otherwise → {@link estimateTokensFromText} at the default ratio.
 *
 * An unknown / forward-compat model id (the CLI doesn't gate `--model` on the
 * registry) degrades to the default ratio rather than throwing, so listings
 * never blow up on a session recorded under a model we don't know.
 *
 * @param modelId - Canonical or alias model id. `undefined` ⇒ default ratio.
 * @param text - Text to estimate.
 * @returns Estimated token count (always ≥ 0, integer).
 */
export function estimateTokensForModel(modelId: string | undefined, text: string): number {
  if (modelId) {
    const entry = findModel(modelId)
    if (entry?.estimateTokens) return entry.estimateTokens(text)
  }
  return estimateTokensFromText(text)
}

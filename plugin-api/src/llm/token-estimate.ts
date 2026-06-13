/**
 * Provider-neutral token estimation (pure core).
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
 * tokenizer family. Each provider's `models.ts` calls
 * {@link makeCharRatioEstimator} with its tokenizer-family ratio.
 *
 * Wave D-2 split: the PURE helpers (`makeCharRatioEstimator`,
 * `estimateTokensFromText`, `DEFAULT_CHARS_PER_TOKEN`, `TokenEstimator`) moved
 * here into the leaf contract package so plugins can build their per-model
 * estimators without reaching into `src/`. The registry-bound
 * `estimateTokensForModel` (which calls `findModel` on host state) STAYS in
 * `src/llm/token-estimate.ts`, which re-exports this module.
 *
 * @module llm/token-estimate
 */

/**
 * Fallback chars-per-token when no model-specific estimator is available.
 * 3.5 matches the heuristic used elsewhere for the live output token estimate
 * and cache-eligibility threshold, so the estimated and live numbers stay in
 * the same ballpark.
 */
export const DEFAULT_CHARS_PER_TOKEN = 3.5

/**
 * A function that estimates the token count of a piece of text. This is the
 * shape stored on `ModelEntry.estimateTokens`.
 */
export type TokenEstimator = (text: string) => number

/**
 * Build a {@link TokenEstimator} from a fixed chars-per-token ratio.
 *
 * Each provider's `models.ts` calls this with its tokenizer-family ratio and
 * stores the result on every `ModelEntry.estimateTokens`. Keeping the factory
 * in the shared contract (rather than re-deriving the arithmetic in each
 * plugin) is what makes the estimate consistent and the wiring a one-liner per
 * model.
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

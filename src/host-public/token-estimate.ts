/**
 * Public re-export shim for `@minimal-agent/core/host/token-estimate`.
 *
 * Token estimation is a provider-to-model decision. `lookupTokenEstimator`
 * gives the registered estimator of a (provider, model) pair, or `undefined`.
 * `estimateTokensForModel` gives the approximate token count of a text, or
 * `undefined` when the model has no estimator. Core has no default ratio:
 * a host shows no token count (for example only bytes) when the result is
 * `undefined`. See `../llm/token-estimate.ts` for the contract.
 *
 * Hosts that estimate many parts of one request (for example the request
 * dump) call `lookupTokenEstimator` one time and use the estimator for each
 * part.
 *
 * @module host-public/token-estimate
 */

export type { TokenEstimator } from "../llm/token-estimate.ts"
export { estimateTokensForModel, lookupTokenEstimator } from "../llm/token-estimate.ts"

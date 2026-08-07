/**
 * Neutral cache-usage accounting type.
 *
 * This is the RESPONSE-side half of "cache" in the codebase: the per-turn
 * token-count payload a provider reports back (`usage`), folded into the
 * session totals by {@link addSessionUsage} in `src/session-tokens.ts`. It is
 * provider-NEUTRAL accounting: any provider that reports cache-read / cache-
 * write token counts populates this shape, and the canonical transport
 * (`src/llm/transport/canonical-send.ts`) feeds it regardless of which
 * provider served the turn.
 *
 * It is deliberately split out of `src/cache.ts` (WORK3 cache decoupling):
 * `cache.ts` also holds the REQUEST-side anomaly detector + debug formatter,
 * which are Anthropic-shaped and slated to relocate/die with the legacy
 * `src/client.ts` (WORK1 Phase D). This type must OUTLIVE that move because a
 * surviving core consumer (`session-tokens.ts`) depends on it, so it lives
 * here in its own neutral module rather than riding the dying file.
 *
 * The field names mirror the wire `usage` payload (verified against net-dbg
 * captures), which is also the de-facto shape the session-token
 * accumulator and the canonical usage bridge already use.
 *
 * @module cache-usage
 */

/**
 * The slice of a turn's `usage` payload the accounting + debug paths care
 * about. Extra wire fields (e.g. `service_tier`, `inference_geo`) are
 * intentionally ignored.
 */
export interface CacheUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

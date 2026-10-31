/**
 * Re-export shim: `src/llm/transport/types.ts`'s `SendOptions` /
 * `StreamedResponse` / `ModelInfo` transport vocabulary, plus its two pure
 * `normalizeModelForAPI` / `has1mContext` helpers, published under
 * `./sdk/transport-types` (S34 exports-gap closure, agent Y1).
 *
 * The real module lives under `src/llm/transport/`, not `src/sdk/`, so
 * `public-api.test.ts`'s target-path rule needs a forwarding file here. The
 * source module has runtime exports (the two helpers above), so a plain
 * `export *` (not `export type *`) carries both the types and the values
 * through unchanged.
 *
 * @module sdk/transport-types
 */

export * from "../llm/transport/types.ts"

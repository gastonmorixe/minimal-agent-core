/**
 * Re-export shim: `src/llm/provider.ts`'s `ProviderAdapter` port plus its
 * validation/preflight types, published under `./sdk/provider` (S34
 * exports-gap closure, agent Y1).
 *
 * The real module lives under `src/llm/`, not `src/sdk/`, so
 * `public-api.test.ts`'s target-path rule needs a forwarding file here. The
 * source module is pure types with zero runtime exports (it re-exports a
 * few plugin-api types too), so `export type *` is both sufficient and
 * required under isolatedModules.
 *
 * @module sdk/provider
 */

export type * from "../llm/provider.ts"

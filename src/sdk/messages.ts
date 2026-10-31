/**
 * Re-export shim: `src/llm/messages.ts`'s provider-neutral `Message` /
 * `ContentBlock` conversation vocabulary, published under `./sdk/messages`
 * (S34 exports-gap closure, agent Y1).
 *
 * The real module lives under `src/llm/`, not `src/sdk/`, so
 * `public-api.test.ts`'s target-path rule needs a forwarding file here. The
 * source module is pure types with zero runtime exports, so `export type *`
 * is both sufficient and required under isolatedModules (same pattern as
 * `src/plugins/types.ts`'s re-export of the plugin-api type contract).
 *
 * @module sdk/messages
 */

export type * from "../llm/messages.ts"

/**
 * Re-export shim: the public part of `src/llm/transport/types.ts`, published
 * under `./sdk/transport-types` (S34 exports-gap closure, agent Y1).
 *
 * The real module lives under `src/llm/transport/`, not `src/sdk/`, so
 * `public-api.test.ts`'s target-path rule needs a forwarding file here.
 *
 * Spec 2.7: core never exports `TransportFn`, `SendOptions`, or
 * `StreamedResponse` by name. They stay internal. A host that needs the
 * transport shape derives it from `SessionOptions["sendFn"]`. This file
 * therefore names each export. Do not change it to `export *`.
 * `public-api.test.ts` fails if any public subpath exports one of the three
 * names.
 *
 * @module sdk/transport-types
 */

export {
  has1mContext,
  type ModelInfo,
  normalizeModelForAPI,
  type RequestType,
  type StreamEvent,
  type SystemBlock,
} from "../llm/transport/types.ts"

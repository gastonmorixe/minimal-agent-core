/**
 * Re-export shim: `src/agent/turn-notice.ts`'s `TurnNotice` discriminated
 * union + `formatTurnNoticePlain` fallback renderer, published under
 * `./sdk/turn-notice` (S34 exports-gap closure, agent Y1).
 *
 * The real module lives beside the agent loop (`src/agent/`), not under
 * `src/sdk/`, so `public-api.test.ts`'s target-path rule ("every export
 * resolves under src/sdk or plugin-api/src") needs a forwarding file here
 * rather than a direct `package.json` pointer at the real path — the same
 * pattern as `src/sdk/runtime.ts` (re-exports `../runtime/index.ts`) and
 * `src/llm/capabilities.ts` (re-exports an already-public leaf package, the
 * reverse direction of this shim, which makes a not-yet-public core module
 * public). `export *` carries both the `TurnNotice` type and the runtime
 * `formatTurnNoticePlain` / `detectStopNotice` helpers through unchanged.
 *
 * @module sdk/turn-notice
 */

export * from "../agent/turn-notice.ts"

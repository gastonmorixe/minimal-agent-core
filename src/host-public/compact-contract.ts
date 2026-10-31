/**
 * Narrow public re-export of src/agent/context-compact.ts's `/compact`
 * command-parsing contract: `CompactRequestOpts`, `CompactStats`,
 * `DEFAULT_KEEP_TAIL`, `parseCompactArgs` only (S34 exports-gap decision,
 * Phase 0 / Bucket C).
 *
 * Deliberately NOT exported here: `buildLocalCompactMessages`,
 * `buildTailCompactMessages`, and the rest of the history-rewrite engine.
 * Those stay core-engine-only per the decision doc's own narrow-import
 * flag — only the `/compact` argv-parsing contract crosses the boundary.
 *
 * @module host-public/compact-contract
 */
export type { CompactRequestOpts, CompactStats } from "../agent/context-compact.ts"
export { DEFAULT_KEEP_TAIL, parseCompactArgs } from "../agent/context-compact.ts"

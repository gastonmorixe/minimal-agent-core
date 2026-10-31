/**
 * Narrow public re-export of the `/compact` contract that crosses the
 * core/CLI boundary:
 *
 * - From src/agent/context-compact.ts, the `/compact` command-parsing
 *   contract: `CompactRequestOpts`, `CompactStats`, `DEFAULT_KEEP_TAIL`,
 *   `parseCompactArgs` only (S34 exports-gap decision, Phase 0 / Bucket C).
 * - From src/plugins/host/providers/context-compact.ts, the drain side of
 *   the plugin `context:compact` queue: `takePendingCompact` only. A host
 *   that opens a session through `runtime.openSession()` directly (the
 *   CLI's interactive session) passes `{ take: () => takePendingCompact() }`
 *   as its `compactSource` port. The queue is a module-level slot that
 *   core's plugin host writes, so the CLI must read this same instance; a
 *   copy in the CLI would be a second, disconnected queue.
 *
 * Deliberately NOT exported here: `buildLocalCompactMessages`,
 * `buildTailCompactMessages`, and the rest of the history-rewrite engine,
 * plus the queue's write/reset side (`createContextCompactApi`,
 * `clearPendingCompact`). Those stay core-engine-only.
 *
 * @module host-public/compact-contract
 */
export type { CompactRequestOpts, CompactStats } from "../agent/context-compact.ts"
export { DEFAULT_KEEP_TAIL, parseCompactArgs } from "../agent/context-compact.ts"
export { takePendingCompact } from "../plugins/host/providers/context-compact.ts"

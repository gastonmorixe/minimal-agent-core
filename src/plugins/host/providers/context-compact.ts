/**
 * Context-compact queue — the `context:compact` capability backing store.
 *
 * A plugin must never compact mid-turn (history rewrite during a tool
 * round corrupts the in-flight turn). So `requestCompact` only QUEUES a
 * request into a process-wide pending slot. The agent loop drains it
 * between tool rounds via `takePendingCompact()` and runs the existing
 * `Agent.compact` / `AgentCore.compact` path there.
 *
 * @module plugins/host/providers/context-compact
 */

import type { ContextCompactApi, RequestCompactOpts } from "../capabilities.ts"

/** Process-wide pending slot. One per agent process. */
let pending: RequestCompactOpts | null = null

/**
 * Build a frozen {@link ContextCompactApi} view over the shared slot.
 * Called by `buildPluginHost` when granted `context:compact`.
 */
export function createContextCompactApi(): ContextCompactApi {
  return {
    requestCompact(opts?: RequestCompactOpts): { queued: boolean } {
      pending = { ...(opts ?? {}) }
      return { queued: true }
    },
  }
}

/** Drain the slot. Returns null when nothing was queued. */
export function takePendingCompact(): RequestCompactOpts | null {
  const out = pending
  pending = null
  return out
}

/** Clear the slot without draining. Test + loop use. */
export function clearPendingCompact(): void {
  pending = null
}

/**
 * `SessionInfo` tool handler.
 *
 * Reports the agent's LIVE runtime state : context fullness, the selected
 * effort/reasoning settings, provider quota, cumulative usage + cost, the
 * current working directory, and uptime. This is the state counterpart to the
 * `ModelInfo` tool's static capability report; call `ModelInfo` for "what can
 * this model do", call `SessionInfo` for "what is my situation right now".
 *
 * Decoupled like the other read-only tools: it pulls from the host's stable
 * data-source functions via `../lib/gather.ts` and never blocks (quota is
 * cache-only).
 *
 * @module plugins/session-info/handlers/session-info
 */

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"
import { gatherSessionInfo } from "../lib/gather.ts"
import { formatSessionInfo } from "../lib/snapshot.ts"

/**
 * Tool handler for `SessionInfo`: gathers the live runtime snapshot (context
 * usage, effort, quota, cost, cwd, uptime) and renders it for both the model
 * and the transcript.
 */
export default async function sessionInfo(ctx: TUIContext): Promise<TUIResult> {
  const snap = await gatherSessionInfo(ctx)

  // Header: the at-a-glance number is context fullness when the window is known.
  const header =
    snap.contextWindow && snap.contextWindow > 0
      ? `${Math.round((snap.contextSize / snap.contextWindow) * 100)}% ctx · ${snap.modelLabel}`
      : `session · ${snap.modelLabel}`

  return {
    kind: "tool_result",
    content: formatSessionInfo(snap),
    displayHeader: header,
  }
}

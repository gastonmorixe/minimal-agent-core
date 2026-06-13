/**
 * `ListAgents` — the fleet at a glance. Cheap: reads the store, renders the
 * snapshot. Pulls no worker transcript into context.
 *
 * @module sub-agents/handlers/list_agents
 */

import type { TUIContext, TUIResult } from "@minimal-agent/plugin-api/types/plugin"

import { fleetText } from "../lib/content.ts"
import { storeFromCtx } from "../lib/handler-deps.ts"
import { renderFleetDisplay } from "../lib/render.ts"

/**
 * Tool handler for `ListAgents`: renders the fleet roster (id, type, status,
 * elapsed, tokens, current activity) from the supervisor store.
 */
export default async function listAgents(ctx: TUIContext): Promise<TUIResult> {
  const store = storeFromCtx(ctx)
  if (!store)
    return { kind: "tool_result", content: "ListAgents: no session id available.", is_error: true }
  const records = store.all()
  const now = Date.now()
  const disp = renderFleetDisplay(records, true, now)
  return {
    kind: "tool_result",
    content: fleetText(records, now),
    displayHeader: disp.header,
    display: disp.body,
    displayFooter: disp.footer,
  }
}

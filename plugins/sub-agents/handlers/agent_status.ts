/**
 * `AgentStatus` — one worker in detail (or the whole fleet when no id). Status,
 * progress, model/isolation/depth, and the linked session id. No transcript.
 *
 * @module sub-agents/handlers/agent_status
 */

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"
import { fleetText, statusDetail } from "../lib/content.ts"
import { storeFromCtx } from "../lib/handler-deps.ts"
import { renderFleetDisplay } from "../lib/render.ts"
import { parseIdArg } from "../lib/validate.ts"

export default async function agentStatus(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "AgentStatus: unexpected trigger", is_error: true }
  }
  const store = storeFromCtx(ctx)
  if (!store) return { kind: "tool_result", content: "AgentStatus: no session id available.", is_error: true }

  const id = parseIdArg(ctx.trigger.input)
  const now = Date.now()

  if (!id) {
    // No id → fall back to the fleet snapshot (same as ListAgents).
    const records = store.all()
    const disp = renderFleetDisplay(records, true, now)
    return {
      kind: "tool_result",
      content: fleetText(records, now),
      displayHeader: disp.header,
      display: disp.body,
      displayFooter: disp.footer,
    }
  }

  const rec = store.get(id)
  if (!rec) return { kind: "tool_result", content: `AgentStatus: unknown sub-agent "${id}".`, is_error: true }
  const disp = renderFleetDisplay([rec], true, now)
  return {
    kind: "tool_result",
    content: statusDetail(rec, now),
    displayHeader: disp.header,
    display: disp.body,
    displayFooter: disp.footer,
  }
}

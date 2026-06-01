/**
 * `CronDelete` tool — cancel a scheduled task by id.
 *
 * @module schedule/handlers/cron_delete
 */

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"
import { cronStoreForSession } from "../lib/store.ts"

export default async function cronDelete(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.env.MINIMAL_AGENT_DISABLE_CRON === "1") {
    return { kind: "tool_result", content: "Scheduling is disabled.", is_error: true }
  }
  const sid = ctx.agent?.sessionId
  if (!sid) {
    return { kind: "tool_result", content: "No active session id.", is_error: true }
  }
  const input = ctx.trigger.type === "tool" ? ctx.trigger.input : {}
  const id = String(input.id ?? "").trim()
  if (!id) {
    return { kind: "tool_result", content: "`id` is required.", is_error: true }
  }

  const store = cronStoreForSession(sid, ctx.env)
  const existed = store.get(id)
  const ok = store.delete(id)
  if (!ok) {
    return {
      kind: "tool_result",
      content: `No scheduled task with id "${id}". Use CronList to see current ids.`,
      is_error: true,
    }
  }
  return {
    kind: "tool_result",
    content: `Canceled scheduled task ${id}.`,
    display: `✓ canceled ${id}${existed ? ` (${existed.prompt.replace(/\s+/g, " ").trim().slice(0, 60)})` : ""}`,
    displayHeader: id,
  }
}

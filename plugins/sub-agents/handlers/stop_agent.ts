/**
 * `StopAgent` — cancel a running worker (signal its pid, mark it stopped).
 *
 * @module sub-agents/handlers/stop_agent
 */

import type { TUIContext, TUIResult } from "@minimal-agent/plugin-api/types/plugin"

import { storeFromCtx } from "../lib/handler-deps.ts"
import { renderStopDisplay } from "../lib/render.ts"
import { stopAgent } from "../lib/service.ts"
import { parseIdArg } from "../lib/validate.ts"

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

/**
 * Tool handler for `StopAgent`: signals the worker's process group, marks the
 * handle stopped with the optional reason, and reports the outcome.
 */
export default async function stop(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "StopAgent: unexpected trigger", is_error: true }
  }
  const id = parseIdArg(ctx.trigger.input)
  if (!id)
    return { kind: "tool_result", content: "StopAgent: an `id` is required.", is_error: true }
  const reason = str(ctx.trigger.input.reason)

  const store = storeFromCtx(ctx)
  if (!store)
    return { kind: "tool_result", content: "StopAgent: no session id available.", is_error: true }

  const r = stopAgent(id, reason, {
    store,
    kill: (pid) => process.kill(pid),
    now: () => new Date(),
  })
  if (!r.ok) return { kind: "tool_result", content: r.error, is_error: true }

  const disp = renderStopDisplay(r.value, true)
  return {
    kind: "tool_result",
    content: `Stopped sub-agent ${r.value.id}${reason ? ` (${reason})` : ""}.`,
    displayHeader: disp.header,
    displayFooter: disp.footer,
  }
}

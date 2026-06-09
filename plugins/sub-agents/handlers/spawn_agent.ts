/**
 * `SpawnAgent` — delegate a unit of work to a background worker. Returns
 * immediately with a handle (the worker runs concurrently); never blocks the
 * lead's loop. Thin wrapper: validate → service → render.
 *
 * @module sub-agents/handlers/spawn_agent
 */

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"
import { serviceDepsFromCtx } from "../lib/handler-deps.ts"
import { renderSpawnDisplay } from "../lib/render.ts"
import { spawnAgent } from "../lib/service.ts"
import { parseSpawnRequest } from "../lib/validate.ts"

export default async function spawn(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "SpawnAgent: unexpected trigger", is_error: true }
  }
  const parsed = parseSpawnRequest(ctx.trigger.input)
  if (!parsed.ok) return { kind: "tool_result", content: parsed.error, is_error: true }

  const deps = serviceDepsFromCtx(ctx)
  if (!deps) {
    return {
      kind: "tool_result",
      content: "SpawnAgent: no session id available; cannot spawn.",
      is_error: true,
    }
  }

  const r = spawnAgent(parsed.value, deps)
  if (!r.ok) return { kind: "tool_result", content: r.error, is_error: true }

  const rec = r.value
  const disp = renderSpawnDisplay(rec, true)
  const content =
    `Spawned sub-agent ${rec.id} (${rec.type} · ${rec.model} · ${rec.isolation}), running in background as session ${rec.sid}. ` +
    `It works concurrently; you are NOT blocked. Track it with ListAgents or AgentStatus ${rec.id}; ` +
    `when it finishes you'll get a one-line digest between turns and can pull the full deliverable with AgentResult ${rec.id}.`
  return {
    kind: "tool_result",
    content,
    displayHeader: disp.header,
    display: disp.body,
    displayFooter: disp.footer,
  }
}

/**
 * Sub-agent → task linkage (decoupled, via the bus).
 *
 * The `sub-agents` plugin emits `subagent.taskUpdate` on the shared event bus
 * when a worker that owns a todo finishes. This handler applies it to the
 * lead's task store: a clean finish ticks the todo `done`; a failure/stop
 * cancels it with the worker's reason. Best-effort — a missing/!resolvable
 * task id is silently ignored (the worker still finished).
 *
 * The two plugins never import each other; they meet on the bus. This is the
 * intended cross-plugin collaboration mechanism.
 *
 * @module tasks/handlers/task_link
 */

import type { EventHandler } from "../../../src/plugins/types.ts"
import { TaskStore } from "../lib/store.ts"

interface TaskUpdatePayload {
  taskId?: string
  status?: string
  reason?: string
  bySubagent?: string
}

const taskLink: EventHandler = (ctx) => {
  const sid = ctx.agent?.sessionId
  if (!sid) return
  const p = (ctx.payload ?? {}) as TaskUpdatePayload
  if (!p.taskId || (p.status !== "done" && p.status !== "canceled")) return
  try {
    // Honor env.HOME like the Task tool handler does, so the same per-session
    // file is read/written (and tests can point HOME at a tmp dir).
    const store = new TaskStore(sid, ctx.env.HOME ? { home: ctx.env.HOME } : {})
    if (p.status === "done") {
      store.done(p.taskId)
    } else {
      const why = p.reason
        ? `${p.reason}${p.bySubagent ? ` (${p.bySubagent})` : ""}`
        : `stopped by ${p.bySubagent ?? "sub-agent"}`
      store.setStatus(p.taskId, "canceled", why)
    }
  } catch {
    // Best-effort: the task may have been removed, or the id may not resolve.
  }
}

export default taskLink

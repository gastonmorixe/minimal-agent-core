/**
 * The scheduler heartbeat — a live-area slot that ticks ≥1s.
 *
 * Thin imperative shell: it supplies the wall clock + `ctx.emit` (the
 * prompt-inject port) to the pure {@link runTick} core, which loads the
 * cron store, fires due tasks between turns, persists the mutated set, and
 * returns the footer status row. The slot lifecycle (in-flight guard,
 * timeout, abort on REPL close) is owned by the host's `LiveAreaScheduler`.
 *
 * @module schedule/handlers/heartbeat
 */

import type { LiveAreaHandlerContext } from "../../../src/plugins/types.ts"
import { cronStoreForSession } from "../lib/store.ts"
import { runTick } from "../lib/tick.ts"

export default async function heartbeat(ctx: LiveAreaHandlerContext): Promise<string | null> {
  if (ctx.env.MINIMAL_AGENT_DISABLE_CRON === "1") return null
  const sid = ctx.agent?.sessionId
  if (!sid) return null

  return runTick({
    store: cronStoreForSession(sid, ctx.env),
    emit: (channel, payload) => ctx.emit?.(channel, payload),
    now: Date.now(),
    firstTick: ctx.tick === 0,
  })
}

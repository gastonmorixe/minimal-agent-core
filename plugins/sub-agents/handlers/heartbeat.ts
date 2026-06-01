/**
 * The fleet supervisor — a live-area slot that ticks ≥1s. Thin shell: builds
 * real deps from `ctx` and runs the pure {@link runSupervisor} pass (probe →
 * tick → persist → effects → widget). Disabled by `MINIMAL_AGENT_DISABLE_SUBAGENTS=1`.
 *
 * @module sub-agents/handlers/heartbeat
 */

import type { LiveAreaHandlerContext } from "../../../src/plugins/types.ts"
import { supervisorDepsFromCtx } from "../lib/handler-deps.ts"
import { runSupervisor } from "../lib/supervisor-shell.ts"

export default async function heartbeat(ctx: LiveAreaHandlerContext): Promise<string | null> {
  if (ctx.env.MINIMAL_AGENT_DISABLE_SUBAGENTS === "1") return null
  const deps = supervisorDepsFromCtx(ctx)
  if (!deps) return null
  return runSupervisor(deps)
}

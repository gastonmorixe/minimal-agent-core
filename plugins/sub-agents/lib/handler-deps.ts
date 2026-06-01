/**
 * Build the injected deps for the Service Layer + supervisor from a live
 * handler context. This is the ONE place the plugin reaches for real OS
 * collaborators (`Bun.spawn`, `process.kill`, `crypto.randomUUID`), keeping
 * every other module pure + testable.
 *
 * @module sub-agents/lib/handler-deps
 */

import { randomUUID } from "node:crypto"

import type { LiveAreaHandlerContext, TUIContext } from "../../../src/plugins/types.ts"

import { resolveDefinition } from "./library.ts"
import { presenceDir } from "./presence.ts"
import {
  resolveAgentBin,
  resolveDefaultModel,
  resolveDepth,
  resolvePolicy,
  resolveSessionsDir,
  resolveTokenBudget,
} from "./runtime.ts"
import { type ServiceDeps } from "./service.ts"
import { realProbeDeps, realSpawnDeps } from "./spawn.ts"
import { SubagentStore } from "./store.ts"
import { type SupervisorDeps } from "./supervisor-shell.ts"
import { sessionId } from "./types.ts"

/** Build {@link ServiceDeps} for a tool handler, or `null` when no session id is plumbed. */
export function serviceDepsFromCtx(ctx: TUIContext): ServiceDeps | null {
  const leadSid = ctx.agent?.sessionId
  if (!leadSid) return null
  const sessionsDir = resolveSessionsDir(ctx.env)
  return {
    store: new SubagentStore(leadSid, { dir: sessionsDir }),
    spawnDeps: realSpawnDeps(),
    agentBin: resolveAgentBin(ctx.env, process.argv),
    leadSid: sessionId(leadSid),
    depth: resolveDepth(ctx.env),
    cwd: ctx.cwd,
    sessionsDir,
    defaultModel: resolveDefaultModel(ctx.env),
    newSid: () => randomUUID(),
    now: () => new Date(),
    resolveDefinition,
    policy: resolvePolicy(ctx.env),
  }
}

/** A store bound to the lead session (for read-only handlers), or `null`. */
export function storeFromCtx(ctx: TUIContext): SubagentStore | null {
  const leadSid = ctx.agent?.sessionId
  if (!leadSid) return null
  return new SubagentStore(leadSid, { dir: resolveSessionsDir(ctx.env) })
}

/** The sessions dir for a tool handler (where child `.log` / `.result.json` live). */
export function sessionsDirFromCtx(ctx: TUIContext): string {
  return resolveSessionsDir(ctx.env)
}

/** Build {@link SupervisorDeps} for the heartbeat slot, or `null` when no session id. */
export function supervisorDepsFromCtx(ctx: LiveAreaHandlerContext): SupervisorDeps | null {
  const leadSid = ctx.agent?.sessionId
  if (!leadSid) return null
  const sessionsDir = resolveSessionsDir(ctx.env)
  return {
    store: new SubagentStore(leadSid, { dir: sessionsDir }),
    probeDeps: realProbeDeps(),
    emit: (channel, payload) => ctx.emit?.(channel, payload),
    kill: (pid) => {
      try {
        process.kill(pid)
      } catch {
        // already gone
      }
    },
    sessionsDir,
    leadSid,
    now: () => new Date(),
    tick: ctx.tick,
    ansi: true,
    tokenBudget: resolveTokenBudget(ctx.env),
    // Publish presence unless opted out. Best-effort agent-mesh.
    ...(ctx.env.MINIMAL_AGENT_SUBAGENT_NO_PRESENCE === "1"
      ? {}
      : {
          presenceDir: presenceDir(ctx.env),
          leadPid: ctx.agent?.pid ?? process.pid,
          ...(ctx.agent?.model ? { leadModel: ctx.agent.model } : {}),
          leadCwd: ctx.cwd,
        }),
  }
}

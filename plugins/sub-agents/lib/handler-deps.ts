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
  resolveDepth,
  resolveModelOverride,
  resolvePolicy,
  resolveSessionsDir,
  resolveTokenBudget,
} from "./runtime.ts"
import { type ServiceDeps } from "./service.ts"
import { realProbeDeps, realSpawnDeps } from "./spawn.ts"
import { SubagentStore } from "./store.ts"
import { type SupervisorDeps } from "./supervisor-shell.ts"
import { sessionId } from "./types.ts"

/**
 * Resolve the default worker model, model/provider-AGNOSTICALLY.
 *
 * Precedence (highest first):
 *   1. `MINIMAL_AGENT_SUBAGENT_MODEL` env override.
 *   2. The LEAD's CURRENT live model via `ctx.queryModelInfo()` — the host fills
 *      this from the shared registry that provider plugins populate, so we stay
 *      decoupled from any specific provider and pick up mid-session model
 *      switches.
 *   3. The lead identity's frozen-at-boot model (`ctx.agent.model`) as a
 *      fallback when the live query isn't wired (subprocess/back-compat).
 *   4. `""` — nothing knowable: the spawn plan OMITS `--model` and the child
 *      self-resolves through its own `userConfig.model ?? DEFAULT_MODEL`.
 *
 * A per-spawn `model` (handled in the service) overrides all of these.
 */
function resolveLeadModel(ctx: TUIContext): string {
  const override = resolveModelOverride(ctx.env)
  if (override) return override
  const live = ctx.queryModelInfo?.()?.modelId?.trim()
  if (live) return live
  return ctx.agent?.model?.trim() || ""
}

/**
 * Map an abstract role → the ACTIVE provider's recommended model + settings,
 * via `ctx.recommendSubagentModels` ONLY (no registry/provider import — the
 * plugin stays decoupled). Returns `undefined` when the host wired no provider
 * or the provider recommends nothing for the role, so the caller falls back to
 * the lead's own model. An explicit env model override short-circuits this
 * entirely (the user's choice wins over a provider suggestion).
 */
function makeRecommendForRole(ctx: TUIContext): ((role: string) => { modelId: string; effort?: string } | undefined) | undefined {
  if (resolveModelOverride(ctx.env)) return undefined
  const query = ctx.recommendSubagentModels
  if (!query) return undefined
  return (role: string) => {
    for (const r of query()) {
      if (r.role === role && r.modelId.trim().length > 0) {
        return { modelId: r.modelId, ...(r.effort ? { effort: r.effort } : {}) }
      }
    }
    return undefined
  }
}

/** Build {@link ServiceDeps} for a tool handler, or `null` when no session id is plumbed. */
export function serviceDepsFromCtx(ctx: TUIContext): ServiceDeps | null {
  const leadSid = ctx.agent?.sessionId
  if (!leadSid) return null
  const sessionsDir = resolveSessionsDir(ctx.env)
  const recommendForRole = makeRecommendForRole(ctx)
  return {
    store: new SubagentStore(leadSid, { dir: sessionsDir }),
    spawnDeps: realSpawnDeps(),
    agentBin: resolveAgentBin(ctx.env, process.argv),
    leadSid: sessionId(leadSid),
    depth: resolveDepth(ctx.env),
    cwd: ctx.cwd,
    sessionsDir,
    defaultModel: resolveLeadModel(ctx),
    newSid: () => randomUUID(),
    now: () => new Date(),
    resolveDefinition,
    ...(recommendForRole ? { recommendForRole } : {}),
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

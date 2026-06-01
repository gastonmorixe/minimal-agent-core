/**
 * Runtime resolvers shared by the handlers + heartbeat: how to re-invoke the
 * agent, this process's nesting depth, the sessions dir, and a default model.
 * These read the environment the host/loader provides; kept tiny and pure-ish
 * (env in, value out) so handlers stay thin.
 *
 * @module sub-agents/lib/runtime
 */

import { DEFAULT_POLICY, type GuardPolicy } from "./guard.ts"
import { ENV_DEPTH } from "./spawn-plan.ts"
import { defaultSessionsDir } from "./store.ts"

/** Read a positive-integer env override, or a fallback. */
function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * How to launch a child `minimal-agent`. Priority:
 *   1. `MINIMAL_AGENT_BIN` (space-separated argv), for packaged installs.
 *   2. `[execPath, entry]` — re-invoke this process's own runtime + entry
 *      (e.g. `[bun, /…/src/index.ts]`), so a dev checkout and a built binary
 *      both spawn the same agent that is running now.
 */
export function resolveAgentBin(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string[] {
  const override = env.MINIMAL_AGENT_BIN?.trim()
  if (override) return override.split(/\s+/)
  const exec = argv[0] ?? "bun"
  const entry = argv[1]
  return entry ? [exec, entry] : [exec]
}

/**
 * This process's nesting depth. The lead (a normal interactive/one-shot run)
 * is depth 0; a spawned worker carries {@link ENV_DEPTH} so it knows it is
 * deeper and can self-enforce the nesting ban.
 */
export function resolveDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_DEPTH]
  if (!raw) return 0
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** The sessions directory (honors `MINIMAL_AGENT_HOME`). */
export function resolveSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return defaultSessionsDir(env)
}

/**
 * Default model for a worker when neither the request nor a definition picks
 * one. Workers default to Haiku: cheap, fast, ideal for the bounded
 * delegated tasks (search, review, focused edits) that delegation is for.
 * Override per-spawn with `model`, or via `MINIMAL_AGENT_SUBAGENT_MODEL`.
 */
export function resolveDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINIMAL_AGENT_SUBAGENT_MODEL?.trim() || "claude-haiku-4-5"
}

/**
 * The guard policy, with env overrides over {@link DEFAULT_POLICY}. Lets a user
 * who wants to run fleets in the extreme (tens-to-hundreds of workers) raise
 * the caps, or a cautious user lower them:
 *   - `MINIMAL_AGENT_SUBAGENT_MAX_CONCURRENT` (default 8)
 *   - `MINIMAL_AGENT_SUBAGENT_MAX_TOTAL`      (default 64)
 *   - `MINIMAL_AGENT_SUBAGENT_MAX_DEPTH`      (default 1 — the nesting ban)
 */
export function resolvePolicy(env: NodeJS.ProcessEnv = process.env): GuardPolicy {
  return {
    maxDepth: intEnv(env, "MINIMAL_AGENT_SUBAGENT_MAX_DEPTH", DEFAULT_POLICY.maxDepth),
    maxConcurrent: intEnv(env, "MINIMAL_AGENT_SUBAGENT_MAX_CONCURRENT", DEFAULT_POLICY.maxConcurrent),
    maxTotal: intEnv(env, "MINIMAL_AGENT_SUBAGENT_MAX_TOTAL", DEFAULT_POLICY.maxTotal),
  }
}

/**
 * Token total above which the fleet widget paints its cost GOLD. Default
 * 200k; override with `MINIMAL_AGENT_SUBAGENT_TOKEN_BUDGET`. Multi-agent burns
 * ~15x chat tokens, so this keeps the cost glanceable.
 */
export function resolveTokenBudget(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env, "MINIMAL_AGENT_SUBAGENT_TOKEN_BUDGET", 200_000)
}

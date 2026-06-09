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
 * Explicit env-level model override for workers, or `""` when unset.
 *
 * The sub-agents plugin is provider/model-AGNOSTIC: it never names a vendor
 * SKU. There is intentionally NO hardcoded fallback here. The real default is
 * resolved one layer up (`handler-deps`) from the LEAD's own live model via
 * `ctx.queryModelInfo()`, so a worker inherits whatever model+provider the user
 * is actually running. When nothing is knowable, the empty string flows through
 * and the spawn plan OMITS `--model` entirely, letting the spawned child
 * self-resolve through its own `userConfig.model ?? DEFAULT_MODEL` path (the
 * same resolution the lead used). Guessing "cheapest" would be wrong: a worker
 * may be free, or smarter than or equal to the parent.
 *
 * Precedence (highest first): per-spawn `model` → `MINIMAL_AGENT_SUBAGENT_MODEL`
 * (this fn) → lead's live model → omit the flag.
 */
export function resolveModelOverride(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINIMAL_AGENT_SUBAGENT_MODEL?.trim() || ""
}

/**
 * Whether to let the active provider auto-pick a per-role model for built-in
 * specialists (scout/balanced/deep tiers), instead of inheriting the lead's
 * model. OFF by default, and that default is deliberate.
 *
 * The old behavior silently downgraded: spawn `explorer` while running Opus and
 * the worker launched on Haiku, spawn `worker` and it launched on Sonnet,
 * because the role recommendation sat AHEAD of the lead's model in precedence.
 * Nobody asked for that. The user is paying for the model they chose; a
 * delegated unit of work runs on that same model unless the user says
 * otherwise. Cost is the user's call to make, not ours to guess.
 *
 * Set `MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1` to opt back into provider role
 * recommendations (cheap scouts, flagship for deep work). Even then, an
 * explicit per-spawn `model` and `MINIMAL_AGENT_SUBAGENT_MODEL` still win.
 */
export function resolveAutoTier(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MINIMAL_AGENT_SUBAGENT_AUTO_TIER === "1"
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
    maxConcurrent: intEnv(
      env,
      "MINIMAL_AGENT_SUBAGENT_MAX_CONCURRENT",
      DEFAULT_POLICY.maxConcurrent,
    ),
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

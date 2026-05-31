/**
 * Agent context: the immutable per-process identity the main agent
 * shares with every plugin handler.
 *
 * The {@link AgentContext} type itself lives in `./types.ts` so plugin
 * authors can `import type { AgentContext } from "<minimal-agent>/src/plugins/types"`
 * without pulling in this module's runtime code. This file owns the
 * runtime concerns: validation, freezing, and the bidirectional bridge
 * to a `MINIMAL_AGENT_*` env-var record.
 *
 * Patterns used here:
 *
 * - **Value object** — `AgentContext` is immutable. Fields are `readonly`
 *   at compile time AND the factory returns a `Object.freeze`-d object
 *   so a misbehaving plugin can't mutate the shared instance and bleed
 *   state into a sibling handler.
 * - **Factory with validation** — {@link createAgentContext} accepts an
 *   `unknown`-shaped input, validates each field, throws on garbage, and
 *   returns the frozen value object. Tests use
 *   {@link createAgentContextForTest} which fills sensible defaults.
 * - **Adapter** — {@link agentContextToEnv} / {@link agentContextFromEnv}
 *   are the ONE place that translates between the typed shape and the
 *   `MINIMAL_AGENT_*` env-var record. The loader's env-build sites
 *   collapse into a single call.
 *
 * @module plugins/agent-context
 */

import type { AgentContext } from "./types.ts"

// ---------------------------------------------------------------------------
// Env-var keys (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Canonical env-var names that {@link agentContextToEnv} produces and
 * {@link agentContextFromEnv} consumes.
 *
 * Kept as a frozen const so callers can reference the keys by name
 * (e.g. for tests that need to clear a specific env var between cases)
 * without risking typos. Adding a new field is a one-line change here,
 * one line in {@link agentContextToEnv}, and one line in
 * {@link agentContextFromEnv}.
 */
export const AGENT_ENV_KEYS = Object.freeze({
  sessionId: "MINIMAL_AGENT_SESSION_ID",
  pid: "MINIMAL_AGENT_PID",
  model: "MINIMAL_AGENT_MODEL",
  version: "MINIMAL_AGENT_VERSION",
} as const)

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Input shape for {@link createAgentContext}. All fields are required;
 * each is validated.
 */
export interface CreateAgentContextInput {
  sessionId: string
  pid: number
  model: string
  version: string
}

/**
 * Build a frozen {@link AgentContext} from raw values, validating each
 * field. Throws on any invalid input so callers never see a partially
 * constructed shared identity.
 *
 * Validation rules:
 * - `sessionId` must be a non-empty trimmed string.
 * - `pid` must be a positive finite integer.
 * - `model` must be a string (empty is allowed for "model unknown" runs).
 * - `version` must be a string (empty is allowed for dev/test runs).
 *
 * The returned object is `Object.freeze`-d. Attempts to mutate a field
 * silently no-op in non-strict callers and throw in strict mode — both
 * are acceptable, since the type system already forbids it.
 *
 * @example
 * ```ts
 * const agent = createAgentContext({
 *   sessionId: getSessionId(),
 *   pid: process.pid,
 *   model: "claude-opus-4-7[1m]",
 *   version: "0.1.0",
 * })
 * ```
 */
export function createAgentContext(input: CreateAgentContextInput): AgentContext {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : ""
  if (sessionId.length === 0) {
    throw new TypeError("createAgentContext: sessionId must be a non-empty string")
  }
  const pid = input.pid
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`createAgentContext: pid must be a positive integer (got ${String(pid)})`)
  }
  if (typeof input.model !== "string") {
    throw new TypeError(`createAgentContext: model must be a string (got ${typeof input.model})`)
  }
  if (typeof input.version !== "string") {
    throw new TypeError(
      `createAgentContext: version must be a string (got ${typeof input.version})`,
    )
  }
  return Object.freeze({
    sessionId,
    pid,
    model: input.model,
    version: input.version,
  })
}

/**
 * Test/dev helper that fills sensible defaults for the rarely interesting
 * fields. Production code should always call {@link createAgentContext}
 * with real values.
 *
 * Defaults:
 * - `pid` → `process.pid`
 * - `model` → `""` (unknown)
 * - `version` → `"0.0.0"`
 *
 * The sessionId is REQUIRED; we don't synthesize a random UUID because
 * test code that forgets to set a session id should fail loudly, not
 * silently associate writes with a fresh per-call session.
 */
export function createAgentContextForTest(
  overrides: Partial<CreateAgentContextInput> & { sessionId: string },
): AgentContext {
  return createAgentContext({
    sessionId: overrides.sessionId,
    pid: overrides.pid ?? process.pid,
    model: overrides.model ?? "",
    version: overrides.version ?? "0.0.0",
  })
}

// ---------------------------------------------------------------------------
// Env-var adapter
// ---------------------------------------------------------------------------

/**
 * Project the typed {@link AgentContext} into a `MINIMAL_AGENT_*` env-var
 * record suitable for merging into a subprocess's environment.
 *
 * Every field is stringified — `pid` becomes a base-10 string. The shape
 * is a partial fragment, not a full env: callers spread it on top of
 * `process.env` (or whatever base env they want):
 *
 * ```ts
 * const env = { ...process.env, ...agentContextToEnv(agent) }
 * ```
 *
 * Symmetric with {@link agentContextFromEnv}: for any valid `a`,
 * `agentContextFromEnv(agentContextToEnv(a))` round-trips to a value
 * that is structurally equal to `a`.
 */
export function agentContextToEnv(agent: AgentContext): Record<string, string> {
  return {
    [AGENT_ENV_KEYS.sessionId]: agent.sessionId,
    [AGENT_ENV_KEYS.pid]: String(agent.pid),
    [AGENT_ENV_KEYS.model]: agent.model,
    [AGENT_ENV_KEYS.version]: agent.version,
  }
}

/**
 * Rehydrate an {@link AgentContext} from a process-env-shaped record
 * (e.g. `process.env` in a subprocess plugin).
 *
 * Returns `null` when the agent identity isn't present in the env (no
 * `MINIMAL_AGENT_SESSION_ID`). The other fields use defensive defaults:
 * - `pid` falls back to `0` for garbage / missing input.
 * - `model` / `version` default to `""`.
 *
 * The returned object is `Object.freeze`-d for the same reasons as
 * {@link createAgentContext}'s output.
 */
export function agentContextFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): AgentContext | null {
  const sessionId = (env[AGENT_ENV_KEYS.sessionId] ?? "").trim()
  if (sessionId.length === 0) return null
  const pidRaw = Number(env[AGENT_ENV_KEYS.pid] ?? "")
  return Object.freeze({
    sessionId,
    pid: Number.isFinite(pidRaw) && pidRaw > 0 ? Math.trunc(pidRaw) : 0,
    model: env[AGENT_ENV_KEYS.model] ?? "",
    version: env[AGENT_ENV_KEYS.version] ?? "",
  })
}

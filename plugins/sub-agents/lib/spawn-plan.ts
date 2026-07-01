/**
 * Pure spawn-plan builder (Strategy: isolation tier `fresh` | `fork`).
 *
 * Turns a validated spawn request into a {@link SpawnPlan}: the argv to launch
 * a headless `minimal-agent` child, the cwd, the env (carrying lineage +
 * depth so the child can self-enforce the nesting ban), the composed prompt,
 * and an optional `fork` pre-step. NO process is spawned here and no file is
 * touched: the imperative shell (`spawn.ts`) executes the plan. This keeps the
 * interesting logic unit-testable without launching anything.
 *
 * @module sub-agents/lib/spawn-plan
 */

import { err, type Isolation, ok, type Result, type SessionId, type SubagentId } from "./types.ts"

/** Env keys the plan stamps so a child knows its lineage + depth. */
export const ENV_DEPTH = "MINIMAL_AGENT_SUBAGENT_DEPTH"
export const ENV_LEAD = "MINIMAL_AGENT_SUBAGENT_LEAD"
export const ENV_ID = "MINIMAL_AGENT_SUBAGENT_ID"

/**
 * The plugin-disable env var the agent boot consumes
 * (`resolvePluginEnabledOverrides`). The spawn plan injects a worker-scoped
 * value into it so a child boots with these plugins off.
 */
export const ENV_DISABLE_PLUGINS = "MINIMAL_AGENT_DISABLE_PLUGINS"

/**
 * Plugins force-disabled for EVERY worker, regardless of role. `intercom` is a
 * peer-to-peer mesh between top-level human-driven sessions; a worker is an
 * internal leaf of one such session and must not appear on the roster or be
 * able to message real peers. (A drifting worker broadcasting to other people's
 * sessions is exactly the failure this prevents.) Sub-agents coordinate through
 * the in-fleet `SubAgentsMailbox`, never intercom.
 */
export const SUBAGENT_DISABLED_PLUGINS: readonly string[] = ["intercom"]

/** A validated request to launch one worker. */
export interface SpawnInput {
  /** How to invoke the agent, e.g. `["minimal-agent"]` or `["bun","run","…/src/index.ts"]`. Injected, never hardcoded. */
  readonly agentBin: readonly string[]
  /** The child's pinned session id (so the supervisor can find its files). */
  readonly childSid: SessionId
  /** The lead session that is spawning this worker. */
  readonly leadSid: SessionId
  /** Short handle id (`"A2"`) — stamped into the child env for its own self-id. */
  readonly id: SubagentId
  /** The delegation prompt (objective + boundaries). */
  readonly task: string
  /**
   * Resolved model id the child runs. May be `""` (empty): the plugin is
   * model-agnostic, so when no model is known the flag is omitted and the child
   * self-resolves its own default. Never a hardcoded vendor SKU.
   */
  readonly model: string
  /**
   * Resolved provider id for the model, e.g. `"opencode"`. When set alongside a
   * non-empty model, the spawn passes `--provider` so the child can resolve the
   * model without re-deriving the provider from its own registry. Optional: when
   * omitted and `model` is set, the child MUST have the provider configured
   * independently (config, env), or boot will fail with "model requires an
   * explicit provider".
   */
  readonly provider?: string
  /** Optional reasoning effort. */
  readonly effort?: string
  /** Writable mode for the child. Non-interactive defaults to read-only ASK, so workers that edit need `"none"` (or another writable mode). */
  readonly mode: string
  /** Context isolation tier. */
  readonly isolation: Isolation
  /** Specialization preamble (the worker definition body), folded into the prompt. */
  readonly systemPreamble?: string
  /**
   * The REQUIRED deliverable-protocol text, ALREADY RENDERED from its markdown
   * template (see `lib/prompts.ts`), appended last so the worker knows how to
   * finish: write any required file itself, then call `ReportResult`. When set,
   * the same sentinel path is also passed via `extraEnv` as
   * `MINIMAL_AGENT_SUBAGENT_RESULT_PATH` so the `ReportResult` handler (and the
   * documented manual fallback) know where to write.
   */
  readonly resultProtocol?: string
  /** This child's nesting depth (lead = 0 → its workers = 1). */
  readonly depth: number
  /** Working directory the child runs in. */
  readonly cwd: string
  /** Extra env to merge (e.g. tool allow/deny markers a future gate reads). */
  readonly extraEnv?: Record<string, string>
  /**
   * The lead's own `MINIMAL_AGENT_DISABLE_PLUGINS` value (raw, comma-separated),
   * if any. The plan UNIONS it with {@link SUBAGENT_DISABLED_PLUGINS} so a
   * worker inherits whatever the user already disabled AND the worker-only
   * disables, instead of the spawn env silently clobbering the inherited list
   * (the child's env overlay wins over the inherited process env, so the merge
   * must happen here). Omit when the lead disabled nothing.
   */
  readonly inheritedDisabledPlugins?: string
}

/** The result of {@link buildSpawnPlan}: everything the shell needs to launch a worker. */
export interface SpawnPlan {
  /** Full argv (executable first). */
  readonly argv: readonly string[]
  /** Directory to run the child in. */
  readonly cwd: string
  /** Env overlay to apply on top of `process.env`. */
  readonly env: Record<string, string>
  /** The composed prompt the child receives (preamble + task). */
  readonly prompt: string
}

/**
 * Compose the child prompt. Layering, top to bottom:
 *   1. the specialization preamble (the worker reads its role first),
 *   2. the concrete task,
 *   3. the REQUIRED result protocol (when supplied).
 *
 * Pure: the `resultProtocol` text is passed in ALREADY RENDERED from its
 * markdown template (see `lib/prompts.ts`), so this module reads no files and
 * holds no prose. The protocol tells the worker how to finish: write any
 * required file itself, then call `ReportResult` to hand the work back (the
 * handler writes the sentinel deterministically). A dedicated
 * `--append-system-prompt` flag would be cleaner; this works today without a
 * core change.
 */
export function composePrompt(
  task: string,
  systemPreamble?: string,
  resultProtocol?: string,
): string {
  const t = task.trim()
  const p = systemPreamble?.trim()
  const base = p ? `${p}\n\n---\n\nYour task:\n\n${t}` : t
  const rp = resultProtocol?.trim()
  if (!rp) return base
  return `${base}\n\n---\n\n${rp}`
}

/**
 * Build a launch plan. Pure. Returns a {@link Result} so callers handle
 * invalid input as a value, not a thrown exception.
 */
export function buildSpawnPlan(input: SpawnInput): Result<SpawnPlan> {
  if (input.agentBin.length === 0) return err("agentBin is empty")
  if (input.task.trim().length === 0) return err("task is empty")
  // NOTE: an empty `model` is intentionally VALID. The sub-agents plugin is
  // model-agnostic and may not know a model id at spawn time (no env override,
  // no live lead model). In that case we OMIT `--model` below so the spawned
  // child self-resolves through its own `userConfig.model ?? DEFAULT_MODEL`,
  // exactly as the lead did. We never substitute a hardcoded vendor SKU here.
  if (!Number.isInteger(input.depth) || input.depth < 1) {
    return err(`depth must be a positive integer, got ${input.depth}`)
  }

  const prompt = composePrompt(input.task, input.systemPreamble, input.resultProtocol)

  const flags: string[] = []
  // `fork`: resume the LEAD's session so its history forks into the child's
  // pinned sid (the agent's resume path forks srcSid → getSessionId(), and
  // `--session-id` pins getSessionId() to the child). This inherits the lead's
  // context AND shares its prompt cache, with no extra core machinery. `fresh`
  // opens a brand-new session with only the task. Both pin `--session-id` so
  // the supervisor knows the sid up front.
  if (input.isolation === "fork") {
    flags.push("--resume", input.leadSid)
  }
  flags.push("--session-id", input.childSid, "--no-header", "--mode", input.mode)
  // Omit `--model` when empty: the child self-resolves its own default model.
  // This keeps the plugin model-agnostic (see the empty-model note above).
  // When model IS set, also pass `--provider` if we know it, so the child can
  // resolve the model without re-deriving the provider from its own registry.
  if (input.model.trim().length > 0) {
    flags.push("--model", input.model.trim())
    if (input.provider && input.provider.trim().length > 0) {
      flags.push("--provider", input.provider.trim())
    }
  }
  if (input.effort && input.effort.trim().length > 0) {
    flags.push("--effort", input.effort.trim())
  }
  // `--prompt` last so the text can't be mistaken for a flag value.
  flags.push("--prompt", prompt)

  const env: Record<string, string> = {
    [ENV_DEPTH]: String(input.depth),
    [ENV_LEAD]: input.leadSid,
    [ENV_ID]: input.id,
    ...input.extraEnv,
    // Union the lead's inherited disables with the worker-only set, deduped and
    // order-stable, so the child boots with intercom (and anything the user
    // already disabled) off. Spread LAST so the worker-disable contract can't be
    // accidentally clobbered by an extraEnv entry for the same key.
    [ENV_DISABLE_PLUGINS]: mergeDisabledPlugins(input.inheritedDisabledPlugins),
  }

  return ok({
    argv: [...input.agentBin, ...flags],
    cwd: input.cwd,
    env,
    prompt,
  })
}

/**
 * Union an inherited comma-separated `MINIMAL_AGENT_DISABLE_PLUGINS` value with
 * {@link SUBAGENT_DISABLED_PLUGINS}, deduped and order-stable (inherited ids
 * first, then the worker-only ids). Pure: string in, string out. The result is
 * always non-empty (it always contains the worker-only set), so a worker can
 * never end up with intercom enabled.
 */
export function mergeDisabledPlugins(inherited?: string): string {
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (raw: string): void => {
    const id = raw.trim()
    if (id.length === 0 || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  if (inherited) for (const part of inherited.split(",")) add(part)
  for (const id of SUBAGENT_DISABLED_PLUGINS) add(id)
  return ids.join(",")
}

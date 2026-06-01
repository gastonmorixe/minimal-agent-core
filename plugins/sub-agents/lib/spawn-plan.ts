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
  /** Optional reasoning effort. */
  readonly effort?: string
  /** Writable mode for the child. Non-interactive defaults to read-only ASK, so workers that edit need `"none"` (or another writable mode). */
  readonly mode: string
  /** Context isolation tier. */
  readonly isolation: Isolation
  /** Specialization preamble (the worker definition body), folded into the prompt. */
  readonly systemPreamble?: string
  /**
   * Absolute path of this worker's result sentinel. When set, the REQUIRED
   * deliverable-protocol block is appended to the prompt so the worker knows
   * exactly where + in what shape to write its result. (The same path is also
   * passed via `extraEnv` as `MINIMAL_AGENT_SUBAGENT_RESULT_PATH`.)
   */
  readonly resultPath?: string
  /** This child's nesting depth (lead = 0 → its workers = 1). */
  readonly depth: number
  /** Working directory the child runs in. */
  readonly cwd: string
  /** Extra env to merge (e.g. tool allow/deny markers a future gate reads). */
  readonly extraEnv?: Record<string, string>
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
 * The REQUIRED deliverable-protocol block, appended to a worker's prompt when a
 * result-sentinel path is known. This is FIX 1: previously the worker was told
 * to "write your result sentinel (see the runtime instructions)" but those
 * instructions were never delivered, so no worker ever wrote one and the
 * transport was dead. Here we state the exact path + JSON schema inline.
 *
 * Distillation (Phase B) is the safety net when this is skipped; this block is
 * the high-signal path that also captures structured `artifacts`.
 */
export function resultProtocolBlock(resultPath: string): string {
  return [
    "## Your deliverable (REQUIRED — how you finish)",
    "Your work is NOT complete until you do BOTH:",
    "1. Produce the artifact the task asked for (e.g. write the file at the path given).",
    "2. As your FINAL action, write your result sentinel to EXACTLY this path:",
    `   ${resultPath}`,
    "   with exactly this JSON shape (a single line is fine):",
    '   {"short": "<2-4 sentence summary of what you produced + where>",',
    '    "tokens": <approx tokens you spent>, "tools": <approx tool calls>,',
    '    "artifacts": ["<absolute path of each file you created/changed>"]}',
    "If you could not finish, STILL write the sentinel with \"short\" starting",
    '"INCOMPLETE: <reason>". Do not end your turn without writing this file.',
  ].join("\n")
}

/**
 * Compose the child prompt. Layering, top to bottom:
 *   1. the specialization preamble (the worker reads its role first),
 *   2. the concrete task,
 *   3. the REQUIRED result protocol (when a `resultPath` is known).
 *
 * (A dedicated `--append-system-prompt` flag would be cleaner; this works today
 * without a core change.)
 */
export function composePrompt(task: string, systemPreamble?: string, resultPath?: string): string {
  const t = task.trim()
  const p = systemPreamble?.trim()
  const base = p ? `${p}\n\n---\n\nYour task:\n\n${t}` : t
  const rp = resultPath?.trim()
  if (!rp) return base
  return `${base}\n\n---\n\n${resultProtocolBlock(rp)}`
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

  const prompt = composePrompt(input.task, input.systemPreamble, input.resultPath)

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
  if (input.model.trim().length > 0) {
    flags.push("--model", input.model.trim())
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
  }

  return ok({
    argv: [...input.agentBin, ...flags],
    cwd: input.cwd,
    env,
    prompt,
  })
}

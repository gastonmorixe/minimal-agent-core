/**
 * Service Layer: the orchestration the tool handlers and heartbeat share.
 *
 * `spawnAgent` ties together the store (Repository), the guard (policy), the
 * spawn-plan (Strategy), and the spawn shell (injected OS) into one
 * application operation, returning a {@link Result}. All collaborators are
 * injected ({@link ServiceDeps}) so the orchestration is unit-testable with a
 * fake launcher and no real process. Tool handlers are thin wrappers that
 * build real deps and render the outcome.
 *
 * @module sub-agents/lib/service
 */

import { DEFAULT_POLICY, evaluateSpawnGuard, type GuardPolicy } from "./guard.ts"
import { renderResultProtocol } from "./prompts.ts"
import { ENV_RESULT_PATH, launchWorker, type SpawnDeps } from "./spawn.ts"
import { buildSpawnPlan } from "./spawn-plan.ts"
import { type SubagentStore } from "./store.ts"
import {
  err,
  type Isolation,
  isActive,
  ok,
  type Result,
  type SessionId,
  type SubagentRecord,
  sessionId,
  ZERO_PROGRESS,
} from "./types.ts"

/** A resolved worker definition (from the library) the service folds into a spawn. */
export interface WorkerDefinition {
  readonly name: string
  readonly systemPrompt?: string
  /**
   * Abstract capability tier for this specialist, NOT a vendor SKU. The host
   * (via a provider's recommendation, see Phase G) or the lead maps a role to a
   * concrete model. Built-in specialists set this and leave {@link model}
   * unset so the plugin stays model-agnostic.
   */
  readonly role?: SubagentRole
  /**
   * Concrete model id. Normally UNSET for built-in specialists (they carry a
   * {@link role} instead). Present only when a definition genuinely must pin a
   * model. An unset model falls back to the lead's model (see `handler-deps`).
   */
  readonly model?: string
  /** Optional reasoning effort. Normally unset: the resolved model's own default applies. */
  readonly effort?: string
  readonly isolation?: Isolation
  readonly color?: string
  readonly budget?: SubagentRecord["budget"]
  /**
   * Operating mode the worker boots in (e.g. `"ask"` to deny Edit/Write at
   * dispatch, `"none"` for an unrestricted writer). READ-ONLY specialists
   * (explorer, planner, reviewer, log-miner) set `"ask"` so the harness refuses
   * mutating tools even though the prompt also tells them not to edit: defense
   * in depth, not prompt-only. Implementers (worker, integrator) leave this
   * unset and the service defaults them to `"none"` (writable). The mode id must
   * match a loaded mode plugin; an unknown id is a silent no-op (the worker runs
   * unrestricted), so only reference modes that ship.
   */
  readonly mode?: string
}

/**
 * Abstract worker capability tiers, decoupled from any provider/model. A
 * provider (Phase G) maps these to concrete models + settings; until then they
 * are descriptive and the worker inherits the lead's model.
 *
 * - `scout`: fast, cheap-leaning, bounded read/search work.
 * - `balanced`: general implementation / planning.
 * - `deep`: heavier reasoning — review, forensic log mining, hard problems.
 */
export type SubagentRole = "scout" | "balanced" | "deep"

/** What the model asked for (already shape-validated by the handler). */
export interface SpawnRequest {
  readonly task: string
  /** A named definition to specialize the worker, or undefined for inline. */
  readonly agent?: string
  /** Inline system prompt (used when `agent` is omitted). */
  readonly system?: string
  readonly model?: string
  readonly effort?: string
  readonly isolation?: Isolation
  readonly label?: string
  readonly budget?: SubagentRecord["budget"]
  /** Link this worker to a tasks-plugin todo; the supervisor ticks it on finish. */
  readonly taskId?: string
  /**
   * Absolute paths this worker MUST produce to count as `done`. When set, the
   * supervisor refuses to mark the worker done unless every path exists and is
   * non-empty; any missing one forces `incomplete` (FIX 4). Lets the lead make
   * "this delegation must produce findings.md" a system-enforced contract rather
   * than a thing it has to remember to check.
   */
  readonly expectArtifacts?: readonly string[]
}

/** Everything the service needs, injected for testability. */
export interface ServiceDeps {
  readonly store: SubagentStore
  readonly spawnDeps: SpawnDeps
  /** How to invoke the agent, e.g. `[execPath, entry]`. */
  readonly agentBin: readonly string[]
  /** The lead session id (this process). */
  readonly leadSid: SessionId
  /** This process's nesting depth (0 for the lead). */
  readonly depth: number
  readonly cwd: string
  /** Sessions directory (where child `.jsonl` / `.log` / `.result.json` live). */
  readonly sessionsDir: string
  /** Default model when neither request nor definition specifies one. */
  readonly defaultModel: string
  /**
   * The lead's own `MINIMAL_AGENT_DISABLE_PLUGINS` value (raw, comma-separated),
   * if set. Threaded into the spawn plan so a worker inherits the lead's
   * disables AND the worker-only ones (intercom). Injected (read from the host's
   * process env) so the plugin stays testable without touching globals. Omit
   * when the lead disabled nothing.
   */
  readonly disabledPlugins?: string
  /** Mint a fresh child session id (uuid). Injected for determinism in tests. */
  readonly newSid: () => string
  readonly now: () => Date
  /** Resolve a named definition, or undefined. Injected (library discovery). */
  readonly resolveDefinition?: (name: string) => WorkerDefinition | undefined
  /**
   * Resolve the ACTIVE provider's recommended model + settings for an abstract
   * role (`scout`/`balanced`/`deep`), or `undefined` when the provider offers
   * none. Injected from `ctx.recommendSubagentModels` so the plugin maps a
   * specialist's role → concrete model WITHOUT importing the registry or any
   * provider. When absent/undefined the worker falls back to `defaultModel`
   * (the lead's own model).
   */
  readonly recommendForRole?: (role: string) => { modelId: string; effort?: string } | undefined
  /**
   * Resolve the provider id that owns a given model id (e.g. `"deepseek-v4-pro"`
   * → `"opencode"`). Injected at the host level so the plugin stays model- and
   * provider-agnostic. When the model is not in the registry, returns `undefined`
   * and the model flag is still passed — the child will fail at boot and surface
   * the real error (same as today for an unknown model).
   */
  readonly resolveProvider?: (modelId: string) => string | undefined
  readonly policy?: GuardPolicy
}

/** Count active + total workers for the guard. */
function counts(records: readonly SubagentRecord[]): { active: number; total: number } {
  let active = 0
  for (const r of records) if (isActive(r.status)) active++
  return { active, total: records.length }
}

/**
 * Spawn one worker. Self-enforces the guard, builds the plan, launches the
 * process, persists the handle. Returns the created record or a reason.
 */
export function spawnAgent(req: SpawnRequest, deps: ServiceDeps): Result<SubagentRecord> {
  const task = req.task?.trim() ?? ""
  if (task.length === 0) return err("task is required")

  const def = req.agent ? deps.resolveDefinition?.(req.agent) : undefined
  if (req.agent && !def) return err(`unknown sub-agent type "${req.agent}"`)

  const type = req.agent ?? "inline"
  const label = (req.label ?? def?.name ?? type).trim()
  // Model precedence (model/provider-agnostic): explicit per-spawn `model` →
  // a definition's explicit `model` → the ACTIVE provider's recommendation for
  // the definition's abstract ROLE → the lead's own model (`defaultModel`).
  //
  // The role-recommendation rung is GATED: `deps.recommendForRole` is wired by
  // the host ONLY when `MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1` (see handler-deps).
  // By default it is undefined, so a role-bearing specialist (`explorer`,
  // `worker`, …) inherits the lead's own model instead of being silently
  // downgraded to a cheaper tier. A worker runs on the model the user is paying
  // for unless the user opts into auto-tiering or names a model per spawn.
  const rec = !req.model && !def?.model && def?.role ? deps.recommendForRole?.(def.role) : undefined
  const model = (req.model ?? def?.model ?? rec?.modelId ?? deps.defaultModel).trim()
  // Provider follows the model: the resolved model determines which provider
  // owns it. We ask `deps.resolveProvider` (wired at the host level from the
  // model registry) so the plugin stays provider-agnostic. An unresolvable
  // provider yields `undefined`, which means we omit `--provider` — the child
  // will fail at boot if it can't self-resolve, surfacing the real error.
  const provider = model ? deps.resolveProvider?.(model)?.trim() : undefined
  // Effort follows the same source as the model: an explicit request/def effort
  // wins, else the role recommendation's effort (only when we actually took the
  // recommended model), else unset (the model's own default applies).
  const effort =
    req.effort ?? def?.effort ?? (rec && !req.model && !def?.model ? rec.effort : undefined)
  const isolation: Isolation = req.isolation ?? def?.isolation ?? "fresh"
  const systemPreamble = req.system ?? def?.systemPrompt
  const budget = req.budget ?? def?.budget
  const expectArtifacts =
    req.expectArtifacts && req.expectArtifacts.length > 0 ? req.expectArtifacts : undefined

  // Guard (self-enforced). External veto can still ride `tool.willInvoke`.
  const records = deps.store.all()
  const { active, total } = counts(records)
  const childDepth = deps.depth + 1
  const verdict = evaluateSpawnGuard(
    { childDepth, type, activeCount: active, totalCount: total },
    deps.policy ?? DEFAULT_POLICY,
  )
  if (!verdict.allowed) return err(verdict.allowed ? "" : verdict.reason)

  const childSid = sessionId(deps.newSid())
  const id = deps.store.nextId()
  const resultPath = `${deps.sessionsDir}/${childSid}.result.json`
  const logPath = `${deps.sessionsDir}/${childSid}.log`

  // Render the deliverable protocol from its markdown template (the prose lives
  // on disk, never in code — repo convention). The worker reads how to finish:
  // write any required file itself, then call `ReportResult`.
  const resultProtocol = renderResultProtocol(resultPath)
  const planResult = buildSpawnPlan({
    agentBin: deps.agentBin,
    childSid,
    leadSid: deps.leadSid,
    id,
    task,
    model,
    ...(provider ? { provider } : {}),
    ...(effort ? { effort } : {}),
    // A read-only specialist (explorer/planner/reviewer/log-miner) carries
    // mode:"ask" so the harness denies Edit/Write at dispatch; an implementer
    // leaves it unset and defaults to "none" (writable). This is the enforcement
    // layer behind each role's "read-only" prompt — a drifting worker that tries
    // to edit is refused by the mode gate, not just discouraged by its prompt.
    mode: def?.mode ?? "none",
    isolation,
    ...(systemPreamble ? { systemPreamble } : {}),
    resultProtocol,
    depth: childDepth,
    cwd: deps.cwd,
    extraEnv: { [ENV_RESULT_PATH]: resultPath },
    // Carry the lead's own plugin-disable list so the plan can UNION it with the
    // worker-only disables (intercom) instead of dropping it. Read from the live
    // process env: whatever disabled the lead's plugins should still apply to
    // its workers.
    ...(deps.disabledPlugins ? { inheritedDisabledPlugins: deps.disabledPlugins } : {}),
  })
  if (!planResult.ok) return err(planResult.error)

  const launched = launchWorker(planResult.value, deps.spawnDeps, logPath)
  if (!launched.ok) return err(launched.error)

  const nowIso = deps.now().toISOString()
  const record: SubagentRecord = {
    id,
    sid: childSid,
    label,
    type,
    model,
    task,
    isolation,
    workspace: "inherit-cwd",
    spawnedAt: nowIso,
    status: { kind: "running", pid: launched.value, startedAt: nowIso, progress: ZERO_PROGRESS },
    ...(budget ? { budget } : {}),
    ...(req.taskId ? { taskId: req.taskId } : {}),
    ...(expectArtifacts ? { expectArtifacts } : {}),
    depth: childDepth,
    leadSid: deps.leadSid,
  }
  deps.store.upsert(record)
  return ok(record)
}

/** Mark a worker stopped + signal its pid (idempotent on an already-terminal worker). */
export function stopAgent(
  id: string,
  reason: string | undefined,
  deps: { store: SubagentStore; kill: (pid: number) => void; now: () => Date },
): Result<SubagentRecord> {
  const rec = deps.store.get(id)
  if (!rec) return err(`unknown sub-agent ${id}`)
  if (rec.status.kind !== "running" && rec.status.kind !== "queued") {
    return ok(rec) // already terminal — nothing to stop
  }
  if (rec.status.kind === "running") {
    try {
      deps.kill(rec.status.pid)
    } catch {
      // pid already gone — fall through to mark stopped
    }
  }
  const stopped: SubagentRecord = {
    ...rec,
    status: { kind: "stopped", endedAt: deps.now().toISOString(), ...(reason ? { reason } : {}) },
  }
  deps.store.upsert(stopped)
  return ok(stopped)
}

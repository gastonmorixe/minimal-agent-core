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
import { buildSpawnPlan } from "./spawn-plan.ts"
import { ENV_RESULT_PATH, launchWorker, type SpawnDeps } from "./spawn.ts"
import { type SubagentStore } from "./store.ts"
import {
  err,
  type Isolation,
  isActive,
  ok,
  type Result,
  type SessionId,
  sessionId,
  type SubagentRecord,
  ZERO_PROGRESS,
} from "./types.ts"

/** A resolved worker definition (from the library) the service folds into a spawn. */
export interface WorkerDefinition {
  readonly name: string
  readonly systemPrompt?: string
  readonly model?: string
  readonly effort?: string
  readonly isolation?: Isolation
  readonly color?: string
  readonly budget?: SubagentRecord["budget"]
}

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
  /** Mint a fresh child session id (uuid). Injected for determinism in tests. */
  readonly newSid: () => string
  readonly now: () => Date
  /** Resolve a named definition, or undefined. Injected (library discovery). */
  readonly resolveDefinition?: (name: string) => WorkerDefinition | undefined
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
  const model = (req.model ?? def?.model ?? deps.defaultModel).trim()
  const effort = req.effort ?? def?.effort
  const isolation: Isolation = req.isolation ?? def?.isolation ?? "fresh"
  const systemPreamble = req.system ?? def?.systemPrompt
  const budget = req.budget ?? def?.budget

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

  const planResult = buildSpawnPlan({
    agentBin: deps.agentBin,
    childSid,
    leadSid: deps.leadSid,
    id,
    task,
    model,
    ...(effort ? { effort } : {}),
    mode: "none",
    isolation,
    ...(systemPreamble ? { systemPreamble } : {}),
    depth: childDepth,
    cwd: deps.cwd,
    extraEnv: { [ENV_RESULT_PATH]: resultPath },
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

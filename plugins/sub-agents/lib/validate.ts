/**
 * Boundary validation for the model-facing tool inputs. Hand-rolled (the repo
 * ships no schema lib) and returns a {@link Result} so a malformed call becomes
 * a teaching `is_error` tool result, not a thrown exception.
 *
 * @module sub-agents/lib/validate
 */

import { type SpawnRequest } from "./service.ts"
import { type Budget, err, type Isolation, ok, type Result } from "./types.ts"

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

function posInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
}

function parseBudget(v: unknown): Budget | undefined {
  if (!v || typeof v !== "object") return undefined
  const o = v as Record<string, unknown>
  const b: Budget = {
    ...(posInt(o.maxTurns) !== undefined ? { maxTurns: posInt(o.maxTurns) } : {}),
    ...(posInt(o.deadlineSec) !== undefined ? { deadlineSec: posInt(o.deadlineSec) } : {}),
    ...(posInt(o.maxTokens) !== undefined ? { maxTokens: posInt(o.maxTokens) } : {}),
  }
  return Object.keys(b).length > 0 ? b : undefined
}

/** Parse + validate a `SpawnAgent` tool input. */
export function parseSpawnRequest(input: Record<string, unknown>): Result<SpawnRequest> {
  const task = str(input.task)
  if (!task) return err("`task` is required (a clear objective with boundaries and the output you want back).")

  const isoRaw = str(input.isolation)
  if (isoRaw && isoRaw !== "fresh" && isoRaw !== "fork") {
    return err(`\`isolation\` must be "fresh" or "fork", got "${isoRaw}".`)
  }
  const isolation = isoRaw as Isolation | undefined

  const budget = parseBudget(input.budget)
  const req: SpawnRequest = {
    task,
    ...(str(input.agent) ? { agent: str(input.agent) } : {}),
    ...(str(input.system) ? { system: str(input.system) } : {}),
    ...(str(input.model) ? { model: str(input.model) } : {}),
    ...(str(input.effort) ? { effort: str(input.effort) } : {}),
    ...(isolation ? { isolation } : {}),
    ...(str(input.label) ? { label: str(input.label) } : {}),
    ...(budget ? { budget } : {}),
    ...(str(input.taskId) ? { taskId: str(input.taskId) } : {}),
  }
  return ok(req)
}

/** Extract a worker id argument (`id` / `agent` / `target`) from a tool input. */
export function parseIdArg(input: Record<string, unknown>): string | undefined {
  return str(input.id) ?? str(input.agent) ?? str(input.target)
}

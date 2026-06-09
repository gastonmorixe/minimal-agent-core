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

/** Parse a bounded array of non-empty strings (e.g. `expectArtifacts`). */
function strArray(v: unknown, max = 32): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
  return out.length > 0 ? out.slice(0, max) : undefined
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
  if (!task)
    return err(
      "`task` is required (a clear objective with boundaries and the output you want back).",
    )

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
    ...(strArray(input.expectArtifacts)
      ? { expectArtifacts: strArray(input.expectArtifacts) }
      : {}),
  }
  return ok(req)
}

/** Extract a worker id argument (`id` / `agent` / `target`) from a tool input. */
export function parseIdArg(input: Record<string, unknown>): string | undefined {
  return str(input.id) ?? str(input.agent) ?? str(input.target)
}

/**
 * The agent-mesh presence producer + reader.
 *
 * Realizes the reserved `~/.minimal-agent/presence.jsonl` mesh the v2 host's
 * `presence:read` capability anticipates — as a DIRECTORY of per-lead files
 * (`<presenceDir>/<leadSid>.jsonl`) so many concurrent agents never contend on
 * one file. Each lead's supervisor rewrites its own small file every tick with
 * a row for itself + each worker; a reader merges the directory (latest row
 * per sid). Covers headless workers (their lead reports them) without needing
 * core lifecycle hooks, which aren't emitted yet.
 *
 * Pure rows/parse/merge/liveness + a thin write/read shell.
 *
 * @module sub-agents/lib/presence
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { type SubagentRecord, type SubagentStatus } from "./types.ts"

/** Liveness flavor of a presence row. `active` = the agent is running. */
export type PresenceStatus = "active" | "queued" | "done" | "incomplete" | "failed" | "stopped"

/** One mesh row. Latest `ts` per `sid` wins on merge. */
export interface PresenceRow {
  readonly sid: string
  readonly role: "lead" | "worker"
  readonly status: PresenceStatus
  /** Process id (0 when not running). */
  readonly pid: number
  readonly ts: string
  readonly model?: string
  readonly cwd?: string
  readonly label?: string
  /** For workers: the lead that owns them. */
  readonly leadSid?: string
}

/** A reading older than this (ms) is treated as stale (the writer likely died mid-write). */
export const STALE_MS = 30_000

/** The mesh directory (honors `MINIMAL_AGENT_HOME`). */
export function presenceDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.MINIMAL_AGENT_HOME?.trim() || join(homedir(), ".minimal-agent")
  return join(base, "presence")
}

/** Map a worker's lifecycle kind to a mesh status. */
function statusOf(s: SubagentStatus): PresenceStatus {
  switch (s.kind) {
    case "running":
      return "active"
    case "queued":
      return "queued"
    case "done":
      return "done"
    case "incomplete":
      return "incomplete"
    case "failed":
      return "failed"
    case "stopped":
      return "stopped"
    default: {
      const _exhaustive: never = s
      throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
    }
  }
}

/** Lead self-identity for a presence snapshot. */
export interface LeadIdentity {
  readonly sid: string
  readonly pid: number
  readonly model?: string
  readonly cwd?: string
}

/**
 * Build the presence rows a lead publishes: one for itself (always `active`)
 * plus one per worker in its fleet. Pure.
 */
export function buildPresenceRows(
  lead: LeadIdentity,
  fleet: readonly SubagentRecord[],
  nowIso: string,
): PresenceRow[] {
  const rows: PresenceRow[] = [
    {
      sid: lead.sid,
      role: "lead",
      status: "active",
      pid: lead.pid,
      ts: nowIso,
      ...(lead.model ? { model: lead.model } : {}),
      ...(lead.cwd ? { cwd: lead.cwd } : {}),
    },
  ]
  for (const r of fleet) {
    rows.push({
      sid: r.sid,
      role: "worker",
      status: statusOf(r.status),
      pid: r.status.kind === "running" ? r.status.pid : 0,
      ts: nowIso,
      model: r.model,
      label: r.label,
      leadSid: lead.sid,
    })
  }
  return rows
}

/** Serialize rows to JSONL. */
export function serializeRows(rows: readonly PresenceRow[]): string {
  return rows.length === 0 ? "" : `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`
}

/** Tolerant JSONL parse. */
export function parseRows(text: string): PresenceRow[] {
  const out: PresenceRow[] = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (o && typeof o.sid === "string" && typeof o.ts === "string") out.push(o as PresenceRow)
    } catch {
      // skip
    }
  }
  return out
}

/** Keep the latest row per sid across many rows. Pure. */
export function mergeLatest(rows: readonly PresenceRow[]): Map<string, PresenceRow> {
  const by = new Map<string, PresenceRow>()
  for (const r of rows) {
    const prev = by.get(r.sid)
    if (!prev || r.ts > prev.ts) by.set(r.sid, r)
  }
  return by
}

/** A liveness verdict for one sid. */
export type Liveness =
  | { readonly status: "live"; readonly pid: number; readonly since: string; readonly role: "lead" | "worker" }
  | { readonly status: "dead"; readonly reason: string }
  | { readonly status: "unknown"; readonly reason: string }

/**
 * Derive liveness from a row. An `active` row that is fresh and whose pid is
 * alive (when a probe is supplied) is `live`; a terminal row is `dead`; a
 * stale `active` row (writer vanished) is `unknown`. Pure given the probe.
 */
export function liveness(
  row: PresenceRow | undefined,
  nowMs: number,
  pidAlive?: (pid: number) => boolean,
): Liveness {
  if (!row) return { status: "unknown", reason: "no presence row" }
  if (row.status !== "active" && row.status !== "queued") {
    return { status: "dead", reason: row.status }
  }
  const age = nowMs - Date.parse(row.ts)
  if (!Number.isFinite(age) || age > STALE_MS) {
    return { status: "unknown", reason: `stale (${Math.round(age / 1000)}s)` }
  }
  if (pidAlive && row.pid > 0 && !pidAlive(row.pid)) {
    return { status: "dead", reason: "pid gone" }
  }
  return { status: "live", pid: row.pid, since: row.ts, role: row.role }
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

/** Rewrite a lead's presence file (small; cheap to rewrite each tick). */
export function writeLeadPresence(dir: string, leadSid: string, rows: readonly PresenceRow[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${leadSid}.jsonl`), serializeRows(rows))
}

/** Read + merge the whole mesh (all per-lead files). Empty when absent. */
export function readMesh(dir: string): Map<string, PresenceRow> {
  if (!existsSync(dir)) return new Map()
  const all: PresenceRow[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue
    try {
      all.push(...parseRows(readFileSync(join(dir, name), "utf-8")))
    } catch {
      // skip unreadable
    }
  }
  return mergeLatest(all)
}

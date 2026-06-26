/**
 * Per-lead worker handle store — the Repository over
 * `~/.minimal-agent/sessions/<leadSid>.subagents.jsonl`.
 *
 * Mirrors the `tasks` plugin's split: pure {@link parseRecords} /
 * {@link serializeRecords} (no IO) sit under a thin {@link SubagentStore}
 * imperative shell that reads/writes the file. One writer per lead by
 * construction (the lead session id is unique), so a full rewrite on each
 * mutation is fine: the file is tiny (one line per worker).
 *
 * The store is collection-like (Repository pattern): `all`, `get`, `upsert`,
 * `replaceAll`. Id minting ({@link nextId}) is pure and monotonic so handles
 * stay stable across removals.
 *
 * @module sub-agents/lib/store
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/plugin-api/utils/agent-paths"

import { type SubagentId, type SubagentRecord, subagentId } from "./types.ts"

// ---------------------------------------------------------------------------
// Pure parse / serialize
// ---------------------------------------------------------------------------

/**
 * Parse JSONL into records. Tolerant: blank lines and unparseable/!object
 * lines are skipped (a corrupt tail must not wipe a fleet). Order preserved.
 */
export function parseRecords(text: string): SubagentRecord[] {
  const out: SubagentRecord[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (obj && typeof obj === "object" && typeof (obj as SubagentRecord).id === "string") {
      out.push(obj as SubagentRecord)
    }
  }
  return out
}

/** Serialize records to JSONL (one compact line each, trailing newline). */
export function serializeRecords(records: readonly SubagentRecord[]): string {
  return records.length === 0 ? "" : `${records.map((r) => JSON.stringify(r)).join("\n")}\n`
}

/**
 * Mint the next worker id for a fleet: prefix + (max existing numeric suffix
 * + 1), so ids are monotonic and never reused even after a record is removed.
 * Pure. Default prefix `"A"` → `A1`, `A2`, … `A100`.
 */
export function nextId(records: readonly SubagentRecord[], prefix = "A"): SubagentId {
  let max = 0
  for (const r of records) {
    if (!r.id.startsWith(prefix)) continue
    const n = Number.parseInt(r.id.slice(prefix.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return subagentId(`${prefix}${max + 1}`)
}

// ---------------------------------------------------------------------------
// Store (imperative shell)
// ---------------------------------------------------------------------------

/** Injectable deps (tests point `dir` at a tmp folder; prod uses the default). */
export interface StoreDeps {
  /** Sessions directory. Defaults to `~/.minimal-agent/sessions`. */
  readonly dir?: string
}

/** Default sessions directory, honoring `MINIMAL_AGENT_HOME` if set. */
export function defaultSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAgentHome(env), "sessions")
}

/**
 * Collection-like access to one lead's worker handles. Construct one per lead
 * session id. Every read hits disk (the file is tiny); every write is a full
 * rewrite.
 */
export class SubagentStore {
  private readonly path: string

  constructor(
    public readonly leadSid: string,
    deps: StoreDeps = {},
  ) {
    const dir = deps.dir ?? defaultSessionsDir()
    this.path = join(dir, `${leadSid}.subagents.jsonl`)
  }

  /** Absolute path to the backing file. */
  filePath(): string {
    return this.path
  }

  /** Load all records (empty when the file is absent). */
  all(): SubagentRecord[] {
    if (!existsSync(this.path)) return []
    return parseRecords(readFileSync(this.path, "utf-8"))
  }

  /** Fetch one record by id, or `null`. */
  get(id: string): SubagentRecord | null {
    return this.all().find((r) => r.id === id) ?? null
  }

  /** Replace the entire fleet (used by the supervisor after a tick). */
  replaceAll(records: readonly SubagentRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, serializeRecords(records))
  }

  /**
   * Insert or replace one record (matched by id), preserving order: an
   * existing id is updated in place; a new id is appended.
   */
  upsert(record: SubagentRecord): void {
    const records = this.all()
    const idx = records.findIndex((r) => r.id === record.id)
    if (idx === -1) records.push(record)
    else records[idx] = record
    this.replaceAll(records)
  }

  /** Mint the next handle id for this fleet (pure {@link nextId} over current state). */
  nextId(prefix = "A"): SubagentId {
    return nextId(this.all(), prefix)
  }
}

/**
 * Per-session cron task store.
 *
 * Persists scheduled tasks to `~/.minimal-agent/sessions/<sid>.cron.json`
 * (a sibling of the queue / tasks / scratch files), so they survive a
 * clean exit and can be restored on `--resume`. The store is the single
 * on-disk source of truth shared by two in-process writers — the
 * `Cron*` tools (model-driven) and the heartbeat slot (timer-driven). Both
 * go through load → mutate → atomic-write, which is race-free in a
 * single-threaded runtime.
 *
 * The store handles IO, malformed-line tolerance, and the 50-task cap. It
 * does NOT decide firing or expiry — that's `scheduler.ts` policy (see
 * {@link pruneExpired}), which the heartbeat applies and writes back.
 *
 * Plugin-isolated: no harness imports; paths are derived from
 * `os.homedir()` and the session id the host passes via `ctx.agent`.
 *
 * @module schedule/lib/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { generateId } from "./id.ts"

/** How a task's next fire time is computed. */
export type CronPace = "fixed" | "dynamic"

/** Where a task came from (provenance, for display only). */
export type CronSource = "tool" | "loop" | "schedule" | "reminder"

/** One scheduled task. */
export interface CronEntry {
  /** 8-char id. */
  id: string
  /** 5-field cron expression (the firing rule for `pace:"fixed"`). */
  cron: string
  /** Prompt injected when the task fires. */
  prompt: string
  /** `false` = one-shot (deletes itself after firing). */
  recurs: boolean
  /** `"fixed"` fires on `cron`; `"dynamic"` fires at `nextAtMs`. */
  pace: CronPace
  /** Creation time (ms epoch). */
  createdAt: number
  /** Last fire time (ms epoch); absent until first fire. Dedupe key. */
  lastFiredAt?: number
  /** Hard expiry (ms epoch). Recurring tasks expire 7 days after creation. */
  expiresAt?: number
  /** For `pace:"dynamic"`: absolute next-fire time (ms epoch). */
  nextAtMs?: number
  /**
   * For `pace:"dynamic"` recurring tasks: the period in ms to re-arm by after
   * each fire. This is how SUB-MINUTE cadences (e.g. `/loop 10s` → 10000) work:
   * cron is minute-granular and can't express them, so those tasks run on the
   * dynamic path and re-arm `nextAtMs = now + intervalMs`. Absent → the
   * scheduler's built-in default (self-paced loops).
   */
  intervalMs?: number
  /** Human cadence label for display, e.g. `"5m"`, `"weekdays 9am"`. */
  label?: string
  /** Provenance tag. */
  source?: CronSource
}

/** Input to {@link CronStore.create}. */
export interface CronCreateInput {
  cron: string
  prompt: string
  recurs: boolean
  pace?: CronPace
  nextAtMs?: number
  /** Re-arm period for sub-minute dynamic tasks; see {@link CronEntry.intervalMs}. */
  intervalMs?: number
  label?: string
  source?: CronSource
}

/** Result type for fallible store ops (typed errors over exceptions). */
export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Max concurrent tasks per session (matches the scheduled-tasks contract). */
export const MAX_TASKS = 50

/** Recurring-task lifetime. */
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Default sessions directory (sibling of queue/tasks/scratch files).
 *
 * Honors `MINIMAL_AGENT_CRON_DIR` as an override (relocation knob + test
 * isolation) before falling back to `~/.minimal-agent/sessions`.
 */
export function defaultCronDir(): string {
  const override = process.env.MINIMAL_AGENT_CRON_DIR
  if (override && override.length > 0) return override
  return join(homedir(), ".minimal-agent", "sessions")
}

/** On-disk path for a session's cron file. */
export function cronFilePath(sid: string, dir: string = defaultCronDir()): string {
  return join(dir, `${sid}.cron.json`)
}

/**
 * Build a store for a session, honoring a `MINIMAL_AGENT_CRON_DIR` override
 * taken from the PLUGIN CONTEXT's env (the decoupled read) rather than
 * global `process.env`. Handlers call this with `ctx.env`.
 *
 * @param sid Session id.
 * @param env The plugin context's environment map.
 */
export function cronStoreForSession(
  sid: string,
  env: Record<string, string | undefined>,
): CronStore {
  const dir = env.MINIMAL_AGENT_CRON_DIR
  return new CronStore(sid, dir ? { dir } : {})
}

/** Validate + coerce one parsed entry; returns null when unusable. */
function coerceEntry(raw: unknown): CronEntry | null {
  if (raw == null || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== "string" || typeof o.cron !== "string") return null
  if (typeof o.prompt !== "string" || typeof o.createdAt !== "number") return null
  const pace: CronPace = o.pace === "dynamic" ? "dynamic" : "fixed"
  const entry: CronEntry = {
    id: o.id,
    cron: o.cron,
    prompt: o.prompt,
    recurs: o.recurs === true,
    pace,
    createdAt: o.createdAt,
  }
  if (typeof o.lastFiredAt === "number") entry.lastFiredAt = o.lastFiredAt
  if (typeof o.expiresAt === "number") entry.expiresAt = o.expiresAt
  if (typeof o.nextAtMs === "number") entry.nextAtMs = o.nextAtMs
  if (typeof o.intervalMs === "number") entry.intervalMs = o.intervalMs
  if (typeof o.label === "string") entry.label = o.label
  if (
    o.source === "tool" ||
    o.source === "loop" ||
    o.source === "schedule" ||
    o.source === "reminder"
  ) {
    entry.source = o.source
  }
  return entry
}

/**
 * Snapshot-on-disk store for one session's cron tasks.
 *
 * Each mutating op reads the latest file, mutates, and atomically rewrites
 * (tmp + rename), so a tool write and a heartbeat write never clobber each
 * other. An empty task set deletes the file (no stale state after a drain).
 */
export class CronStore {
  /** Absolute path to `<sid>.cron.json`. */
  readonly path: string
  private readonly dir: string
  private readonly rand: () => number

  constructor(sid: string, opts: { dir?: string; rand?: () => number } = {}) {
    this.dir = opts.dir ?? defaultCronDir()
    this.path = cronFilePath(sid, this.dir)
    this.rand = opts.rand ?? Math.random
  }

  /** Convenience factory. */
  static forSession(sid: string, opts: { dir?: string; rand?: () => number } = {}): CronStore {
    return new CronStore(sid, opts)
  }

  /**
   * Load all tasks from disk. Returns `[]` when the file is absent or
   * unreadable. Malformed entries are dropped individually (best-effort),
   * mirroring the session-log loss model.
   */
  load(): CronEntry[] {
    if (!existsSync(this.path)) return []
    let text: string
    try {
      text = readFileSync(this.path, "utf-8")
    } catch {
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    const out: CronEntry[] = []
    for (const item of parsed) {
      const e = coerceEntry(item)
      if (e) out.push(e)
    }
    return out
  }

  /**
   * Atomically persist the full task set. An empty array unlinks the file
   * so a clean drain leaves nothing behind.
   */
  save(entries: CronEntry[]): void {
    if (entries.length === 0) {
      try {
        rmSync(this.path, { force: true })
      } catch {
        /* ignore */
      }
      return
    }
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf-8")
    renameSync(tmp, this.path)
  }

  /**
   * Create + persist a new task. Enforces the 50-task cap and computes the
   * 7-day expiry for recurring tasks.
   *
   * @param input Task definition.
   * @param now Injectable clock (ms epoch).
   */
  create(input: CronCreateInput, now: number = Date.now()): StoreResult<CronEntry> {
    const entries = this.load()
    if (entries.length >= MAX_TASKS) {
      return { ok: false, error: `task limit reached (${MAX_TASKS}); delete one first` }
    }
    const id = generateId((x) => entries.some((e) => e.id === x), this.rand)
    const entry: CronEntry = {
      id,
      cron: input.cron,
      prompt: input.prompt,
      recurs: input.recurs,
      pace: input.pace ?? "fixed",
      createdAt: now,
    }
    if (input.recurs) entry.expiresAt = now + SEVEN_DAYS_MS
    if (input.nextAtMs !== undefined) entry.nextAtMs = input.nextAtMs
    if (input.label !== undefined) entry.label = input.label
    if (input.source !== undefined) entry.source = input.source
    entries.push(entry)
    this.save(entries)
    return { ok: true, value: entry }
  }

  /** Look up one task by id. */
  get(id: string): CronEntry | undefined {
    return this.load().find((e) => e.id === id)
  }

  /** Delete a task by id. Returns true when something was removed. */
  delete(id: string): boolean {
    const entries = this.load()
    const next = entries.filter((e) => e.id !== id)
    if (next.length === entries.length) return false
    this.save(next)
    return true
  }

  /** Replace the entire task set (used by the scheduler after a tick). */
  replaceAll(entries: CronEntry[]): void {
    this.save(entries)
  }

  /** Current task count. */
  count(): number {
    return this.load().length
  }
}

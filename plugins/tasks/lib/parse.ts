/**
 * Task parser, id generation, and JSONL serialization for the `tasks` plugin.
 *
 * Tasks files are JSONL — one task per line, line order is display order.
 * Schema is captured in {@link TASK_LINE_SCHEMA_VERSION} and rendered into
 * each line so a future format bump is detectable. The model never
 * hand-edits this file (unlike the memory plugin's markdown format), so
 * we get the robustness of JSON parsing without paying the lossless
 * round-trip cost.
 *
 * ## Id format
 *
 * Two id regimes coexist on the same file:
 *
 * - **Top-level tasks** — six lowercase hex characters from
 *   `crypto.randomBytes(3)` (e.g. `a7b3c4`). 16.7M space per session is
 *   ample; the store retries on the astronomically unlikely collision.
 *   The visible `#` prefix is presentation only; ids are stored bare.
 *
 * - **Subtasks** — parent-id + single lowercase alpha suffix (e.g.
 *   `d04c91a`, `d04c91b`). Up to 26 children per parent (realistic
 *   counts are 2-6); the store throws if a 27th child is requested. The
 *   suffix is the parent's child-counter mod 26 plus the byte; children
 *   keep their suffix even after siblings are removed (no renumber on
 *   delete to preserve stable ids).
 *
 * Both forms are accepted by the public id-resolution helpers; the
 * regex {@link TASK_ID_RE} matches either.
 *
 * @module tasks/lib/parse
 */

import { randomBytes } from "node:crypto"

// ---------------------------------------------------------------------------
// Status state machine
// ---------------------------------------------------------------------------

/**
 * Lifecycle states a task can be in.
 *
 * - `todo` — created, not yet started. Default for new tasks.
 * - `doing` — actively being worked. The agent is encouraged to flip to
 *   `doing` BEFORE starting the work, so the user sees real-time focus.
 * - `done` — work completed.
 * - `canceled` — abandoned. Sideband: typically used when the user
 *   redirects the agent. Carries an optional `reason`.
 */
export type TaskStatus = "todo" | "doing" | "done" | "canceled"

export const TASK_STATUSES: readonly TaskStatus[] = ["todo", "doing", "done", "canceled"]

/** Type guard. */
export function isTaskStatus(s: unknown): s is TaskStatus {
  return typeof s === "string" && (TASK_STATUSES as readonly string[]).includes(s)
}

// ---------------------------------------------------------------------------
// Task model
// ---------------------------------------------------------------------------

/**
 * A parsed task from the per-session JSONL file.
 *
 * Top-level tasks have `parent === null` and contribute to the display
 * numbering. Subtasks have `parent` set to their parent's id and are NOT
 * numbered (their position is implied by tree order).
 */
export interface Task {
  /** Six hex chars for top-level, parent-id + alpha suffix for subtasks. No `#` prefix. */
  id: string
  /** Parent task id (no `#`), or `null` for top-level tasks. */
  parent: string | null
  /** Lifecycle state. See {@link TaskStatus}. */
  status: TaskStatus
  /** Free-text title. Single line by convention; the renderer truncates long ones. */
  title: string
  /** ISO 8601 timestamp (local time, offset included) when the task was first created. */
  created_at: string
  /** ISO 8601 timestamp when status flipped to `done`. `null` otherwise. */
  done_at: string | null
  /** Optional reason recorded with a `canceled` status. */
  reason: string | null
  /**
   * ISO 8601 timestamp of the FIRST `*→doing` transition this task ever
   * experienced (schema v2+). Set once when the task first enters `doing`
   * and never overwritten — even on subsequent `doing→todo→doing` cycles.
   * `null` for tasks that never started. The renderer uses this together
   * with {@link active_ms} to render duration columns.
   *
   * On v1-format input, this parses as `null`.
   */
  started_at: string | null
  /**
   * ISO 8601 timestamp of the MOST RECENT `*→doing` transition (schema
   * v2+). Set on every entry into `doing`, cleared on every exit. While
   * the task is `doing`, live elapsed = {@link active_ms} + (now − this).
   * `null` whenever the task is not currently `doing`.
   *
   * On v1-format input, this parses as `null`.
   */
  last_resumed_at: string | null
  /**
   * Total accumulated time-in-`doing` (milliseconds), accruing across
   * pause/resume cycles. On every `doing→*` transition the store adds
   * `now − last_resumed_at` to this counter. For a task currently in
   * `doing`, this is the time accumulated UP TO the most recent resume —
   * live elapsed is `active_ms + (now − last_resumed_at)`.
   *
   * On v1-format input, this parses as `0`.
   */
  active_ms: number
}

/**
 * Inputs the store accepts to create a new task. The id, timestamps,
 * and (for subtasks) the alpha suffix are derived inside the store.
 */
export interface NewTaskInput {
  title: string
  parent?: string | null
  status?: TaskStatus
}

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

/**
 * Schema version embedded on every line. Bump when the on-disk shape
 * changes incompatibly. Older lines with a missing or lower version
 * are still parsed best-effort (forward-compatibility within the major
 * series), then re-serialized with the current version on the next write.
 *
 * ## Version history
 *
 * - **v1** — initial shape: id, parent, status, title, created_at,
 *   done_at, reason.
 * - **v2** — adds `started_at`, `last_resumed_at`, `active_ms` for
 *   per-task duration tracking. v1 files parse forward-compatibly with
 *   the new fields defaulted to `null` / `0` (best-effort: tasks created
 *   pre-v2 never accrue retroactive durations, but the renderer simply
 *   omits the duration column for them).
 */
export const TASK_LINE_SCHEMA_VERSION = 2

// ---------------------------------------------------------------------------
// Id helpers
// ---------------------------------------------------------------------------

/**
 * Regex matching a valid task id — either a six-hex top-level id or a
 * six-hex parent + a-z suffix subtask id. Used by the handler to accept
 * `#abc123` or `#abc123d` from model input.
 */
export const TASK_ID_RE = /^[0-9a-f]{6}([a-z])?$/

/** True if `s` is a syntactically valid task id (top-level or subtask). */
export function isTaskId(s: unknown): s is string {
  return typeof s === "string" && TASK_ID_RE.test(s)
}

/** True if `id` looks like a subtask id (parent-hash + a-z suffix). */
export function isSubtaskId(id: string): boolean {
  return id.length === 7 && /^[0-9a-f]{6}[a-z]$/.test(id)
}

/** Return the parent id of a subtask id (six-hex prefix). Throws for non-subtask ids. */
export function parentOf(subtaskId: string): string {
  if (!isSubtaskId(subtaskId)) {
    throw new Error(`parentOf: not a subtask id: "${subtaskId}"`)
  }
  return subtaskId.slice(0, 6)
}

/**
 * Generate a fresh six-hex top-level task id. Injectable RNG for tests.
 *
 * The caller is responsible for checking the id isn't already in use in
 * the live store (collisions are 1-in-16.7M per generation, but the
 * store still calls back to retry on the unlucky case).
 */
export function newTopLevelId(rand: () => Buffer = () => randomBytes(3)): string {
  return rand().toString("hex")
}

/**
 * Generate a subtask id from a parent id and a 0-based child counter.
 * `0` → suffix `a`, `1` → `b`, ..., `25` → `z`. Throws on overflow.
 *
 * Counter is intentionally NOT re-derived from "current children" so
 * that removing a child doesn't shift the remaining ids — child ids stay
 * stable for the life of the parent.
 */
export function subtaskId(parentId: string, counter: number): string {
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error(`subtaskId: counter must be a non-negative integer (got ${counter})`)
  }
  if (counter >= 26) {
    throw new Error(
      `subtaskId: too many children of #${parentId} (max 26, requested index ${counter})`,
    )
  }
  if (!/^[0-9a-f]{6}$/.test(parentId)) {
    throw new Error(`subtaskId: parent must be a six-hex top-level id (got "${parentId}")`)
  }
  const suffix = String.fromCharCode("a".charCodeAt(0) + counter)
  return `${parentId}${suffix}`
}

/**
 * ISO 8601 local-time timestamp with offset, second precision. Used for
 * `created_at`, `done_at`, `started_at`, and `last_resumed_at`. Matches
 * the memory plugin's `localIsoSeconds` exactly so a future merge of
 * the two formats stays easy.
 */
export function localIsoSeconds(now: () => Date = () => new Date()): string {
  const d = now()
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  const yyyy = d.getFullYear()
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const hh = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const ss = pad(d.getSeconds())
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? "+" : "-"
  const offH = pad(Math.floor(Math.abs(offMin) / 60))
  const offM = pad(Math.abs(offMin) % 60)
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${offH}:${offM}`
}

/**
 * Local date+time formatted as `"YYYY-MM-DD HH:MM:SS"` (no `T`, no
 * timezone offset, second precision). Used by the renderer for the
 * minimalist date-and-year suffix in the task block header.
 *
 *     2026-05-20 18:07:42
 *
 * Matches the ISO calendar date the user explicitly approved, with the
 * action time appended in the same `tool-time.ts`-compatible `HH:MM:SS`
 * format. Pure presentation — never serialized to disk.
 */
export function localIsoDateTime(now: () => Date = () => new Date()): string {
  const d = now()
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  const yyyy = d.getFullYear()
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const hh = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const ss = pad(d.getSeconds())
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * On-disk shape — JSON object with a `v` field for schema versioning.
 * Field order is fixed for human-readable diffs.
 *
 * v2 added `started_at`, `last_resumed_at`, `active_ms` at the tail of
 * the field order so v1 lines remain a strict prefix of v2 lines for
 * easy `diff` reading across the schema bump.
 */
interface OnDisk {
  v: number
  id: string
  parent: string | null
  status: TaskStatus
  title: string
  created_at: string
  done_at: string | null
  reason: string | null
  /** v2+ */
  started_at: string | null
  /** v2+ */
  last_resumed_at: string | null
  /** v2+ */
  active_ms: number
}

/**
 * Serialize one task to a JSONL line (no trailing newline).
 *
 * Field order is fixed (`v`, `id`, `parent`, `status`, `title`,
 * `created_at`, `done_at`, `reason`, `started_at`, `last_resumed_at`,
 * `active_ms`) so git diffs on the file are stable across writers.
 */
export function formatTask(t: Task): string {
  const line: OnDisk = {
    v: TASK_LINE_SCHEMA_VERSION,
    id: t.id,
    parent: t.parent,
    status: t.status,
    title: t.title,
    created_at: t.created_at,
    done_at: t.done_at,
    reason: t.reason,
    started_at: t.started_at,
    last_resumed_at: t.last_resumed_at,
    active_ms: t.active_ms,
  }
  return JSON.stringify(line)
}

/**
 * Parse a single JSONL line into a Task. Returns `null` for blank lines
 * or lines that don't validate as a task (corrupted file, future schema).
 * The store treats `null` lines as "skip silently" so a partial-write
 * crash doesn't render the whole file unusable.
 *
 * Forward-compat: v1 lines (no `started_at` / `last_resumed_at` /
 * `active_ms`) parse cleanly with those fields defaulted to `null` /
 * `null` / `0`. The renderer treats `active_ms === 0` as "no duration
 * to show" and elides the column, so a v1 session resumed under v2
 * code shows the new column only for tasks that have actually been
 * started/transitioned under v2.
 */
export function parseTask(line: string): Task | null {
  const trimmed = line.trim()
  if (trimmed === "") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>

  // Required fields. Reject unless every one is present and well-typed.
  if (typeof o.id !== "string" || !isTaskId(o.id)) return null
  if (o.parent !== null && (typeof o.parent !== "string" || !isTaskId(o.parent))) return null
  if (!isTaskStatus(o.status)) return null
  if (typeof o.title !== "string") return null
  if (typeof o.created_at !== "string") return null
  if (o.done_at !== null && o.done_at !== undefined && typeof o.done_at !== "string") return null
  if (o.reason !== null && o.reason !== undefined && typeof o.reason !== "string") return null

  // v2+ fields (optional for forward-compat with v1 lines).
  if (o.started_at !== null && o.started_at !== undefined && typeof o.started_at !== "string") {
    return null
  }
  if (
    o.last_resumed_at !== null &&
    o.last_resumed_at !== undefined &&
    typeof o.last_resumed_at !== "string"
  ) {
    return null
  }
  // `active_ms` may be absent (v1) or any non-negative finite number (v2).
  // Negative / NaN / +Inf are corrupt and reject; missing is fine.
  if (o.active_ms !== undefined) {
    if (typeof o.active_ms !== "number" || !Number.isFinite(o.active_ms) || o.active_ms < 0) {
      return null
    }
  }

  return {
    id: o.id,
    parent: o.parent ?? null,
    status: o.status,
    title: o.title,
    created_at: o.created_at,
    done_at: (o.done_at as string | null | undefined) ?? null,
    reason: (o.reason as string | null | undefined) ?? null,
    started_at: (o.started_at as string | null | undefined) ?? null,
    last_resumed_at: (o.last_resumed_at as string | null | undefined) ?? null,
    active_ms: typeof o.active_ms === "number" ? o.active_ms : 0,
  }
}

/**
 * Parse a whole JSONL file's contents into tasks, in source order.
 * Bad/blank lines are silently dropped — corruption is logged elsewhere
 * by the store, not in the pure parser.
 */
export function parseFile(content: string): Task[] {
  const out: Task[] = []
  for (const line of content.split("\n")) {
    const t = parseTask(line)
    if (t !== null) out.push(t)
  }
  return out
}

/**
 * Serialize an ordered task list to a JSONL file body (trailing newline
 * included). Idempotent with {@link parseFile}: parse → serialize yields
 * the same bytes for any task list the writer emitted.
 */
export function serializeFile(tasks: readonly Task[]): string {
  if (tasks.length === 0) return ""
  return `${tasks.map(formatTask).join("\n")}\n`
}

// ---------------------------------------------------------------------------
// ID normalization (model-input → store-key)
// ---------------------------------------------------------------------------

/**
 * Resolve a model-provided id reference into a bare task id (no `#`).
 *
 * Accepts:
 *  - `"#abc123"` → `"abc123"` (top-level)
 *  - `"abc123"`  → `"abc123"` (top-level)
 *  - `"#abc123d"` → `"abc123d"` (subtask)
 *  - `"abc123d"` → `"abc123d"` (subtask)
 *
 * Does NOT accept numeric position references (`"3"`, `3`) — those are
 * resolved against a live task list and live in the store, not here.
 *
 * Returns the bare id on success, or `null` if the input doesn't match a
 * task-id shape after stripping the `#` prefix.
 */
export function normalizeIdRef(ref: string): string | null {
  const bare = ref.startsWith("#") ? ref.slice(1) : ref
  if (!isTaskId(bare)) return null
  return bare
}

/**
 * History store — append-only JSONL with per-project + global layout.
 *
 * One submitted prompt → one row → one line of JSON. We append in
 * lockstep to TWO files:
 *
 *   - `~/.minimal-agent/projects/<absolute-cwd>/history.jsonl`
 *     (primary — recall walks this on ↑/↓)
 *
 *   - `~/.minimal-agent/history.jsonl`
 *     (global mirror — future Ctrl+R search)
 *
 * Layout mirrors the `memory` plugin's per-project scoping so a `cd`
 * never silently shares prompts between repos, while still per-user
 * (never inside the project tree, never committed).
 *
 * ## Wire format
 *
 * Each row:
 *
 *   `{"id":"<id>","ts":"<iso>","sid":"<uuid|null>","cwd":"<abs-path>","text":"...","exit":"submitted"|"canceled"}`
 *
 * Stable — append-only, never edit. `id` is the same
 * `<base36-millis>-<rand4hex>` format the memory plugin uses (sortable,
 * opaque, 1/65536 intra-ms collision odds).
 *
 * ## Atomic-ish appends
 *
 * `appendFileSync` opens with `O_APPEND` which gives per-write atomicity
 * up to ~PIPE_BUF (~4KB on POSIX). A typical row is ~200 bytes, so
 * concurrent appends from sibling minimal-agent processes interleave
 * cleanly — no lockfile dance needed.
 *
 * ## Cap rotation
 *
 * When a file exceeds `MAX_FILE_BYTES` (default 10 MB), we truncate the
 * oldest 25% on the next append. Single-process operation; if two
 * processes hit the cap at the same time one truncates and the other
 * does nothing (the second `statSync` sees the new smaller size and
 * skips). Worst case the cap is briefly overshot by one row.
 *
 * @module plugins/history/lib/store
 */

import { randomBytes } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Resolve the user's home directory, preferring `$HOME` over `os.homedir()`.
 * Matches the convention every CLI tool uses (bash, git, ssh, …) — and
 * crucially makes paths testable by exporting `HOME=/tmp/something`.
 *
 * `os.homedir()` on POSIX calls `getpwuid(getuid()).pw_dir`, which ignores
 * `$HOME`. We want the env var to win so tests / sandboxes can redirect
 * the entire data tree.
 */
function userHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME && env.HOME.length > 0 ? env.HOME : homedir()
}

/** Environment variable that disables ALL reads and writes when set to `"1"`. */
export const HISTORY_DISABLE_ENV = "MINIMAL_AGENT_NO_HISTORY"

/**
 * Optional namespace for tests / sandboxed experiments. When set, every
 * path returned by this module is rebased under
 * `~/.minimal-agent/namespaces/<ns>/...` so the user's real history is
 * untouched. Mirrors `MINIMAL_AGENT_MEMORY_NAMESPACE`.
 */
export const HISTORY_NAMESPACE_ENV = "MINIMAL_AGENT_HISTORY_NAMESPACE"

/** Hard ceiling per file before rotation kicks in. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

/** Fraction of the file truncated (from the head) when the cap is hit. */
export const ROTATE_FRACTION = 0.25

/** One row in the JSONL file. */
export interface HistoryEntry {
  /** Stable `<base36-millis>-<rand4hex>` id. */
  id: string
  /** ISO-8601 timestamp (seconds-resolution, with timezone). */
  ts: string
  /** Session id this submission came from. `null` outside a session. */
  sid: string | null
  /** Absolute working directory at submit time. */
  cwd: string
  /** The prompt text. May be multi-line; embedded `\n` are preserved by JSON. */
  text: string
  /**
   * How the submission left the editor. `"submitted"` is the common
   * case (Enter); `"canceled"` is reserved for future "save canceled
   * drafts" capture (not wired in v1).
   */
  exit: "submitted" | "canceled"
}

/**
 * Resolve the user's minimal-agent home, honoring the namespace env var.
 * Internal — callers should use {@link globalHistoryPath} /
 * {@link projectHistoryPath}.
 */
function maHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = userHome(env)
  const ns = env[HISTORY_NAMESPACE_ENV]
  if (ns && ns.length > 0) {
    return join(home, ".minimal-agent", "namespaces", ns)
  }
  return join(home, ".minimal-agent")
}

/** Absolute path of the global history file. */
export function globalHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(maHome(env), "history.jsonl")
}

/**
 * Absolute path of the per-project history file. `cwd` is treated as
 * opaque text and mirrored into the path tree (matching the memory
 * plugin's projects layout).
 */
export function projectHistoryPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  // `cwd` is absolute on every supported platform; we strip a leading
  // separator (or `C:\` style drive) by joining unconditionally — `join`
  // collapses extra separators sanely.
  return join(maHome(env), "projects", cwd, "history.jsonl")
}

/**
 * Generate a stable `<base36-millis>-<rand4hex>` id.
 *
 * Sortable lexicographically because base36 of `Date.now()` preserves
 * numeric ordering within a fixed digit count. 4 hex chars (16 bits) of
 * randomness makes intra-millisecond collisions ~1/65536.
 *
 * Injectable for tests via the `now` / `rand` deps.
 */
export function newEntryId(
  now: () => number = Date.now,
  rand: () => Buffer = () => randomBytes(2),
): string {
  const millis = now().toString(36)
  const tail = rand().toString("hex")
  return `${millis}-${tail}`
}

/**
 * `true` when the user has opted out of history via
 * `MINIMAL_AGENT_NO_HISTORY=1`. All reads and writes become no-ops.
 */
export function isDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HISTORY_DISABLE_ENV] === "1"
}

/** Ensure the parent directory of `path` exists. Best-effort, no throw. */
function ensureParent(path: string): void {
  const dir = path.slice(0, path.lastIndexOf("/"))
  if (dir.length === 0) return
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // best-effort
  }
}

/**
 * Append one entry to `path`. Truncates the oldest {@link ROTATE_FRACTION}
 * of the file FIRST if size exceeds {@link MAX_FILE_BYTES}. Errors are
 * swallowed (logged via `logger` if provided) — history is best-effort,
 * never blocks the REPL.
 */
export function appendOne(
  path: string,
  entry: HistoryEntry,
  opts: {
    maxBytes?: number
    rotateFraction?: number
    logger?: (msg: string) => void
  } = {},
): void {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES
  const rotateFraction = opts.rotateFraction ?? ROTATE_FRACTION
  const log = opts.logger ?? (() => {})
  ensureParent(path)
  // Rotate first so the appended row always lands in a within-cap file.
  try {
    if (existsSync(path)) {
      const sz = statSync(path).size
      if (sz > maxBytes) rotateInPlace(path, rotateFraction, log)
    }
  } catch (err) {
    log(`history: rotation check failed for ${path}: ${err instanceof Error ? err.message : err}`)
  }
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf-8" })
  } catch (err) {
    log(`history: append failed for ${path}: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Append `entry` to BOTH the project-scoped file and the global mirror.
 * No-op when disabled by env var.
 *
 * `projectCwd` is the cwd used to compute the project file path. It's
 * separate from `entry.cwd` (which is recorded as metadata on the row
 * itself). In production they always match; tests sometimes diverge
 * them.
 */
export function appendBoth(
  entry: HistoryEntry,
  opts: {
    projectCwd?: string
    env?: NodeJS.ProcessEnv
    maxBytes?: number
    rotateFraction?: number
    logger?: (msg: string) => void
  } = {},
): void {
  const env = opts.env ?? process.env
  if (isDisabled(env)) return
  const cwd = opts.projectCwd ?? entry.cwd
  appendOne(projectHistoryPath(cwd, env), entry, opts)
  appendOne(globalHistoryPath(env), entry, opts)
}

/**
 * Drop the oldest `fraction` portion of `path` in place. Reads the
 * whole file, finds the first `\n` past the cut point, rewrites with
 * everything after it.
 *
 * Cut at a line boundary keeps the file a valid JSONL stream — the
 * worst case is one mid-rotation row gets dropped, which is exactly
 * what we want (drop oldest, keep tail intact).
 */
function rotateInPlace(path: string, fraction: number, log: (msg: string) => void): void {
  try {
    const text = readFileSync(path, "utf-8")
    const cut = Math.floor(text.length * fraction)
    const nl = text.indexOf("\n", cut)
    if (nl < 0 || nl >= text.length - 1) {
      // No clean cut point — wipe the file rather than risk leaving a
      // single broken line behind. This is rare in practice (only
      // happens when the entire file is one giant line OR the cut
      // lands past the last newline).
      writeFileSync(path, "", "utf-8")
      log(`history: rotated ${path} (full wipe — no clean line boundary at ${cut})`)
      return
    }
    writeFileSync(path, text.slice(nl + 1), "utf-8")
    log(`history: rotated ${path} (dropped ${nl + 1} bytes of head)`)
  } catch (err) {
    log(`history: rotation failed for ${path}: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Read all entries from `path`. Returns oldest-first. Malformed lines
 * (parse failure, missing fields) are skipped silently — a corrupted
 * row never poisons the rest of the file. Empty / missing file returns
 * `[]`.
 *
 * Synchronous and reads the whole file into memory. Adequate for a
 * 10 MB cap (~50k entries at 200 bytes each); for larger budgets,
 * switch to a streaming reader.
 */
export function loadEntries(
  path: string,
  opts: { logger?: (msg: string) => void } = {},
): HistoryEntry[] {
  const log = opts.logger ?? (() => {})
  if (!existsSync(path)) return []
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch (err) {
    log(`history: read failed for ${path}: ${err instanceof Error ? err.message : err}`)
    return []
  }
  const out: HistoryEntry[] = []
  for (const raw of text.split("\n")) {
    if (raw.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue // malformed line — skip
    }
    if (!isHistoryEntry(parsed)) continue
    out.push(parsed)
  }
  return out
}

function isHistoryEntry(v: unknown): v is HistoryEntry {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === "string" &&
    typeof o.ts === "string" &&
    (o.sid === null || typeof o.sid === "string") &&
    typeof o.cwd === "string" &&
    typeof o.text === "string" &&
    (o.exit === "submitted" || o.exit === "canceled")
  )
}

/** Build a fresh entry stamped with `now()`'s ISO timestamp. */
export function buildEntry(
  args: {
    text: string
    cwd: string
    sid: string | null
    exit?: "submitted" | "canceled"
  },
  deps: {
    now?: () => Date
    rand?: () => Buffer
  } = {},
): HistoryEntry {
  const nowDate = deps.now ? deps.now() : new Date()
  return {
    id: newEntryId(() => nowDate.getTime(), deps.rand),
    ts: nowDate.toISOString(),
    sid: args.sid,
    cwd: args.cwd,
    text: args.text,
    exit: args.exit ?? "submitted",
  }
}

// ── test helpers ────────────────────────────────────────────────────────

/**
 * Delete BOTH the project and global history files. Used by tests and
 * the CLI's `clear` subcommand. Best-effort — silently swallows errors.
 *
 * @internal
 */
export function _clearAll(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): void {
  for (const p of [globalHistoryPath(env), projectHistoryPath(cwd, env)]) {
    try {
      rmSync(p, { force: true })
    } catch {
      // best-effort
    }
  }
}

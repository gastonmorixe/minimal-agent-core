// FORMAT v1
//
// Append-only JSONL session log. One file per session at
// `~/.minimal-agent/sessions/<sid>.jsonl`. The first record is always a
// `meta` record. Every subsequent record represents one observable event
// at a turn boundary (user message submitted, assistant turn completed,
// tool result produced, free-form note). Mid-stream tokens NEVER touch
// disk — we commit at boundaries only, so a `kill -9` mid-turn loses the
// in-flight turn but never corrupts prior history.
//
// Each line is a single `JSON.stringify(record)` followed by `\n`. A torn
// last line (write interrupted before `\n`) is detected and dropped on
// load by `parseLines` below; earlier lines are never silently dropped.
//
// The sid is the same UUID returned by `getSessionId()` from
// `src/metadata.ts` — i.e. the value also sent in the
// `x-claude-code-session-id` HTTP header. This keeps file id, API id, and
// `.net-dbg/` capture id aligned.
//
// FORMAT-CHANGE POLICY: bump the `// FORMAT vN` marker in this file AND
// add a `formatVersion` field to the `meta` record. Old sessions remain
// readable forever — `foldRecords` is responsible for understanding the
// version mix.

import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname as osHostname } from "node:os"
import { join } from "node:path"
import type { ContentBlock, ToolResultBlock } from "./client.ts"

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

export interface MetaRecord {
  kind: "meta"
  formatVersion: 1
  sid: string
  createdAt: string
  model: string
  cwd: string
  /** Hash of the active system prompt at session start. Resume warns on mismatch. */
  systemHash: string
  /** Hash of the tool list (names + descriptions + schemas) at session start. */
  toolsHash: string
  agentVersion: string
}

export interface UserRecord {
  kind: "user"
  ts: string
  /** Same shape we push onto `Agent.messages` — string OR content blocks. */
  content: string | ContentBlock[]
  /**
   * Stable unique id for this user prompt. Generated at write time. Used as
   * the target by `RewindRecord.to`. Optional for backward compat with
   * sessions written before this field existed.
   */
  id?: string
}

export interface AssistantRecord {
  kind: "assistant"
  ts: string
  content: ContentBlock[]
  stopReason: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export interface ToolResultRecord {
  kind: "tool_result"
  ts: string
  tool_use_id: string
  content: string | ContentBlock[]
  isError: boolean
}

export interface NoteRecord {
  kind: "note"
  ts: string
  text: string
}

/**
 * Rewind marker. When folding records into the live `messages[]`, encountering
 * a rewind drops every message after the target user prompt (the prompt with
 * `id === to` is KEPT). Multiple rewinds compose: each operates on the
 * already-folded message list at that point in the log.
 *
 * The rewind itself is metadata — it is NOT a message. `droppedCount` is
 * informational (used by the replay renderer to show "M messages discarded").
 */
export interface RewindRecord {
  kind: "rewind"
  ts: string
  /** `UserRecord.id` of the prompt to rewind to. That prompt is kept. */
  to: string
  /** Number of dropped records, for replay/UX. Not load-bearing. */
  droppedCount: number
}

/**
 * Process-attach marker. Written once on session open (new OR resume) so any
 * other process can answer "is an agent currently attached to this session?"
 *
 * Liveness is determined by probing the live OS (kill(pid,0) + start-time
 * match), NOT by trusting this record alone. PIDs get reused; `startTime`
 * pins identity beyond the pid. `hostname` guards against home dirs on
 * network shares / sync'd folders where the pid is meaningless to us.
 *
 * See `src/session-liveness.ts` for the query side.
 */
export interface AttachRecord {
  kind: "attach"
  ts: string
  pid: number
  ppid: number
  /** ISO 8601, captured from `ps -o lstart=` for our own pid at startup. */
  startTime: string
  hostname: string
  agentVersion: string
}

/**
 * Best-effort clean-shutdown marker. Pairs with the latest AttachRecord by
 * pid. MAY be missing (SIGKILL, crash, power loss) — readers MUST NOT treat
 * its absence as "still alive". It is purely an optimization that lets the
 * reader skip the OS probe.
 */
export interface DetachRecord {
  kind: "detach"
  ts: string
  pid: number
  reason: "exit" | "signal" | "error"
  exitCode?: number
}

export type SessionRecord =
  | MetaRecord
  | UserRecord
  | AssistantRecord
  | ToolResultRecord
  | NoteRecord
  | RewindRecord
  | AttachRecord
  | DetachRecord

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Root directory: `~/.minimal-agent/sessions/`. */
export function defaultSessionsDir(): string {
  return join(homedir(), ".minimal-agent", "sessions")
}

/** Full path for a session's JSONL log. */
export function sessionFilePath(sid: string, dir: string = defaultSessionsDir()): string {
  return join(dir, `${sid}.jsonl`)
}

/** Index file for fast listing without scanning every session file. */
export function indexFilePath(dir: string = defaultSessionsDir()): string {
  return join(dir, "index.jsonl")
}

// ---------------------------------------------------------------------------
// Index records (one line per session, written at session open)
// ---------------------------------------------------------------------------

export interface IndexRecord {
  sid: string
  createdAt: string
  cwd: string
  model: string
  argv?: string[]
}

// ---------------------------------------------------------------------------
// Parse helpers (also used by session-restore)
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL blob into records. Lines that fail to parse are dropped
 * with a soft warning (returned in `dropped`); the *last* line is the
 * common case (torn write at crash time) and is always tolerated.
 */
export function parseLines(text: string): {
  records: SessionRecord[]
  dropped: { line: number; reason: string }[]
} {
  const records: SessionRecord[] = []
  const dropped: { line: number; reason: string }[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as SessionRecord
      if (typeof parsed !== "object" || parsed === null || typeof parsed.kind !== "string") {
        dropped.push({ line: i + 1, reason: "not a record object" })
        continue
      }
      records.push(parsed)
    } catch (err) {
      dropped.push({
        line: i + 1,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { records, dropped }
}

// ---------------------------------------------------------------------------
// Process identity helpers (used by AttachRecord + session-liveness)
// ---------------------------------------------------------------------------

/**
 * Read a process's wall-clock start time from `ps -o lstart=`. Returns null
 * if the process does not exist, ps is unavailable, or the output cannot be
 * parsed. The returned string is normalized to ISO 8601 so on-disk values
 * compare with strict equality.
 *
 * Works on macOS and Linux. The kernel records lstart at process creation
 * and never updates it, so this is stable against later wall-clock skew.
 */
export function readProcessStartTime(pid: number): string | null {
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
    })
    if (r.status !== 0) return null
    const raw = (r.stdout ?? "").trim()
    if (!raw) return null
    const t = new Date(raw).getTime()
    if (!Number.isFinite(t)) return null
    return new Date(t).toISOString()
  } catch {
    return null
  }
}

let _ownStartTime: string | null = null

/**
 * Capture our own process start time once and cache it. Falls back to
 * "now" if `ps` is unavailable; in that case PID-reuse detection becomes
 * a no-op for this session, but `kill(0)` liveness still works.
 */
export function getOwnStartTime(): string {
  if (_ownStartTime != null) return _ownStartTime
  _ownStartTime = readProcessStartTime(process.pid) ?? new Date().toISOString()
  return _ownStartTime
}

/** Test-only: reset the cached start time. */
export function _resetOwnStartTimeForTest(): void {
  _ownStartTime = null
}

// ---------------------------------------------------------------------------
// SessionStore — append-only writer
// ---------------------------------------------------------------------------

/**
 * Append-only writer for a single session file. Use `SessionStore.open(...)`
 * to create+initialize (writes `meta` + index entry). Use the static
 * `SessionStore.load(sid)` (in `session-restore.ts`) for read-only access.
 *
 * Every `append*` call writes one line synchronously and flushes. We
 * deliberately use `appendFileSync` rather than a buffered writer: each
 * record represents a turn-boundary event, of which there are O(turns)
 * per session, not O(tokens). Throughput is not the bottleneck;
 * correctness on `kill -9` is.
 */
export class SessionStore {
  readonly sid: string
  readonly path: string
  readonly agentVersion: string
  private readonly dir: string

  private constructor(sid: string, dir: string, agentVersion: string) {
    this.sid = sid
    this.dir = dir
    this.agentVersion = agentVersion
    this.path = sessionFilePath(sid, dir)
  }

  /**
   * Open a brand-new session file, write the `meta` record, and append a
   * line to `index.jsonl`. If a file at this sid already exists,
   * `existsOk: false` (default) throws — this is almost certainly a bug
   * (sid collision or accidental reuse). Pass `existsOk: true` from a
   * resume path that wants to keep appending to an existing file.
   */
  static open(opts: {
    sid: string
    model: string
    cwd: string
    systemHash: string
    toolsHash: string
    agentVersion: string
    argv?: string[]
    dir?: string
    existsOk?: boolean
    /** Override the timestamp; tests use this for determinism. */
    now?: () => Date
  }): SessionStore {
    const dir = opts.dir ?? defaultSessionsDir()
    mkdirSync(dir, { recursive: true })
    const store = new SessionStore(opts.sid, dir, opts.agentVersion)
    const now = (opts.now ?? (() => new Date()))()
    const createdAt = now.toISOString()

    const fileExists = (() => {
      try {
        readFileSync(store.path, "utf-8")
        return true
      } catch {
        return false
      }
    })()

    if (fileExists && !opts.existsOk) {
      throw new Error(
        `SessionStore.open: file already exists at ${store.path} (pass existsOk:true to append)`,
      )
    }

    if (!fileExists) {
      const meta: MetaRecord = {
        kind: "meta",
        formatVersion: 1,
        sid: opts.sid,
        createdAt,
        model: opts.model,
        cwd: opts.cwd,
        systemHash: opts.systemHash,
        toolsHash: opts.toolsHash,
        agentVersion: opts.agentVersion,
      }
      writeFileSync(store.path, `${JSON.stringify(meta)}\n`, { flag: "wx" })

      const indexRecord: IndexRecord = {
        sid: opts.sid,
        createdAt,
        cwd: opts.cwd,
        model: opts.model,
        argv: opts.argv,
      }
      appendFileSync(indexFilePath(dir), `${JSON.stringify(indexRecord)}\n`)
    }

    return store
  }

  /**
   * Append an `attach` record marking that THIS process is now attached
   * to this session. Call once, immediately after `open()` — and again
   * (cheap, idempotent in effect) on every resume.
   *
   * The recorded `startTime` is captured at first call to
   * {@link getOwnStartTime} and cached for the life of the process.
   */
  appendAttach(now: Date = new Date()): void {
    const rec: AttachRecord = {
      kind: "attach",
      ts: now.toISOString(),
      pid: process.pid,
      ppid: typeof process.ppid === "number" ? process.ppid : 0,
      startTime: getOwnStartTime(),
      hostname: osHostname(),
      agentVersion: this.agentVersion,
    }
    this.write(rec)
  }

  /**
   * Append a best-effort clean-shutdown marker. Failure to write (e.g.
   * because we're already in `process.exit`) is swallowed — readers do
   * NOT depend on this record for correctness.
   */
  appendDetach(reason: DetachRecord["reason"], exitCode?: number, now: Date = new Date()): void {
    const rec: DetachRecord = {
      kind: "detach",
      ts: now.toISOString(),
      pid: process.pid,
      reason,
      ...(exitCode != null ? { exitCode } : {}),
    }
    try {
      this.write(rec)
    } catch {
      // Best-effort. Don't crash mid-shutdown.
    }
  }

  /**
   * Append a `user` record. Call this immediately after pushing onto
   * `Agent.messages`. Returns the freshly-generated `id` so callers (e.g.
   * the rewind picker) can reference this prompt later.
   */
  appendUser(content: string | ContentBlock[], now: Date = new Date()): string {
    const id = randomUUID()
    this.write({ kind: "user", ts: now.toISOString(), content, id })
    return id
  }

  /** Append an `assistant` record. Call after a complete assistant turn. */
  appendAssistant(
    content: ContentBlock[],
    stopReason: string | null,
    usage?: AssistantRecord["usage"],
    now: Date = new Date(),
  ): void {
    this.write({ kind: "assistant", ts: now.toISOString(), content, stopReason, usage })
  }

  /** Append a `tool_result` record. Call after every tool execution incl. abort. */
  appendToolResult(block: ToolResultBlock, now: Date = new Date()): void {
    this.write({
      kind: "tool_result",
      ts: now.toISOString(),
      tool_use_id: block.tool_use_id,
      content: block.content,
      isError: !!block.is_error,
    })
  }

  /** Free-form annotation (mode change, error, manual marker). */
  appendNote(text: string, now: Date = new Date()): void {
    this.write({ kind: "note", ts: now.toISOString(), text })
  }

  /**
   * Append a `rewind` record marking the session as rewound to the user
   * prompt with id `toMsgId`. Append-only: the dropped records remain on
   * disk; `foldRecords` honors this marker on read to produce the effective
   * conversation. `droppedCount` is informational (for replay UX).
   */
  appendRewind(toMsgId: string, droppedCount: number, now: Date = new Date()): void {
    this.write({ kind: "rewind", ts: now.toISOString(), to: toMsgId, droppedCount })
  }

  /** Spec alias for {@link appendRewind}. */
  recordRewind(toMsgId: string, droppedCount: number, now: Date = new Date()): void {
    this.appendRewind(toMsgId, droppedCount, now)
  }

  private write(rec: SessionRecord): void {
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`)
  }
}

// ---------------------------------------------------------------------------
// Hashing helpers (used by index.ts to compute systemHash/toolsHash)
// ---------------------------------------------------------------------------

/**
 * Stable short hash for arbitrary input. Not cryptographic — just enough
 * to detect drift between session-save-time and resume-time. FNV-1a 32-bit
 * rendered as 8 hex chars; collisions are fine because we only use it to
 * say "warn the user that something changed".
 */
export function shortHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

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

import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
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

export type SessionRecord =
  | MetaRecord
  | UserRecord
  | AssistantRecord
  | ToolResultRecord
  | NoteRecord
  | RewindRecord

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
  private readonly dir: string

  private constructor(sid: string, dir: string) {
    this.sid = sid
    this.dir = dir
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
    const store = new SessionStore(opts.sid, dir)
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

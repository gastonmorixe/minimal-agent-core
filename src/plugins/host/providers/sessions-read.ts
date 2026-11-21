/**
 * `sessions:read` capability provider — the host-side adapter that
 * implements {@link SessionsReadApi} over the session store
 * (`src/session-store.ts`, `src/session-restore.ts`,
 * `src/session-liveness.ts`).
 *
 * Ports & Adapters: `capabilities.ts` is the PORT a plugin consumes
 * (re-declared structurally on the plugin side, no `src/` import); this
 * file is the ADAPTER the host wires behind it. All heavy scanning happens
 * here so only bounded DTOs ({@link RecordView}, {@link SearchHit}, ...)
 * ever cross into plugin/model context.
 *
 * Everything is injectable (`dir`) so tests run against a temp sessions
 * directory without touching `~/.minimal-agent`.
 *
 * @module plugins/host/providers/sessions-read
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { isRuntimeAttachmentText } from "../../../agent/runtime-attachments.ts"
import type { ContentBlock, TextBlock, ToolUseBlock } from "../../../llm/messages.ts"
import { readParsedSessionIndex } from "../../../session/session-index.ts"
import { getSessionLiveness, type Liveness } from "../../../session/session-liveness.ts"
import { loadSession } from "../../../session/session-restore.ts"
import {
  defaultSessionsDir,
  type IndexRecord,
  type MetaRecord,
  parseLines,
  type SessionRecord,
  sessionFilePath,
} from "../../../session/session-store.ts"
import { readTitleState, type SessionTitleState } from "../../../session/session-title.ts"
import { NO_SIDEBAND } from "../../../sideband/api.ts"
import type { SidebandReader } from "../../../sideband/types.ts"
import type {
  BodyPart,
  RecordFacts,
  RecordView,
  RecordWindow,
  SearchHit,
  SessionIndexEntry,
  SessionLiveness,
  SessionMetaView,
  SessionsReadApi,
  TitleSource,
  ToolCallHit,
  WindowOpts,
} from "../capabilities.ts"

// ---------------------------------------------------------------------------
// Tunables (single source of truth for the API's documented defaults)
// ---------------------------------------------------------------------------

const WINDOW_DEFAULT_LIMIT = 50
const WINDOW_MAX_LIMIT = 500
const PREVIEW_DEFAULT_CHARS = 600
const PREVIEW_MIN_CHARS = 80
const LIST_DEFAULT_LIMIT = 25
const SEARCH_DEFAULT_LIMIT = 20
const SEARCH_DEFAULT_MAX_SESSIONS = 10
const TOOLCALLS_DEFAULT_LIMIT = 20

// Session ids are UUIDs, so this allowlist (the same class already used for
// tool_use_id in blobs-read) is safe and sufficient. It rejects "." and "/",
// which blocks path-traversal payloads like "../../../../etc" from escaping
// the sessions root through join(dir, sid + ".jsonl") and friends.
const SAFE_SID = /^[A-Za-z0-9_-]+$/

/** Reject any sid not shaped like a real session id (path-traversal guard). */
function isSafeSid(sid: string): boolean {
  return SAFE_SID.test(sid)
}

/** Constructor deps — `dir` overrides the sessions directory (tests). */
export interface SessionsReadDeps {
  dir?: string
  /**
   * The sideband reader that finds the runtime attachment blocks (design
   * step 8). Default `NO_SIDEBAND`: no unmarked block is hidden.
   */
  sideband?: SidebandReader
}

const TOOLCALL_INPUT_PREVIEW_CHARS = 200
const FIRST_PROMPT_CHARS = 100

/** Build the host-side `sessions:read` implementation. */
export function createSessionsReadApi(deps: SessionsReadDeps = {}): SessionsReadApi {
  const dir = deps.dir ?? defaultSessionsDir()
  const sb = deps.sideband ?? NO_SIDEBAND

  return {
    async list(opts = {}) {
      const limit = clampInt(opts.limit, 1, 200, LIST_DEFAULT_LIMIT)
      const offset = Math.max(0, opts.offset ?? 0)
      const parsed = readParsedSessionIndex(dir)
      const all = liveSessions(parsed.sessions, dir)
      const q = opts.query?.toLowerCase()
      // The query also matches the saved title of the sid (the sidecar title
      // line by the display order user > ai > derived, as the catalog).
      const titleHit = (sid: string): boolean => {
        const t = parsed.titles.get(sid)
        if (t === undefined || q === undefined) return false
        const shown = [t.user, t.ai, t.derived].find((r) => r?.title)?.title
        return shown?.toLowerCase().includes(q) === true
      }
      const filtered = all.filter((e) => {
        if (opts.cwd && e.cwd !== opts.cwd) return false
        if (
          q &&
          !(e.sid.toLowerCase().includes(q) || e.cwd.toLowerCase().includes(q) || titleHit(e.sid))
        ) {
          return false
        }
        return true
      })
      // Newest first: the index is append-ordered (oldest first).
      const newestFirst = [...filtered].reverse()
      const items = newestFirst.slice(offset, offset + limit).map(
        (e): SessionIndexEntry => ({
          sid: e.sid,
          createdAt: e.createdAt,
          cwd: e.cwd,
          model: e.model,
        }),
      )
      return { items, total: filtered.length }
    },

    title(sid) {
      if (!isSafeSid(sid) || !existsSync(sessionFilePath(sid, dir))) return null
      return shownTitle(readTitleState(sid, dir)).title ?? null
    },

    async meta(sid) {
      if (!isSafeSid(sid)) return null
      const records = readRecords(sid, dir)
      if (records === null) return null
      const meta = records.find((r): r is MetaRecord => r.kind === "meta") ?? null

      const counts: Record<string, number> = {}
      let lastActivity: string | null = meta?.createdAt ?? null
      for (const r of records) {
        counts[r.kind] = (counts[r.kind] ?? 0) + 1
        const ts = recordTs(r)
        if (ts && (!lastActivity || ts > lastActivity)) lastActivity = ts
      }

      return {
        sid,
        createdAt: meta?.createdAt ?? null,
        cwd: meta?.cwd ?? null,
        model: meta?.model ?? null,
        provider: null,
        effort: null,
        agentVersion: meta?.agentVersion ?? null,
        parentSid: meta?.parentSid ?? null,
        recordCount: records.length,
        counts,
        firstPromptChars: FIRST_PROMPT_CHARS,
        firstPromptParts: firstPromptParts(records),
        lastActivity,
        liveness: toSessionLiveness(getSessionLiveness(sid, { dir })),
        modelChanges: [],
        hasTasks: existsSync(join(dir, `${sid}.tasks.jsonl`)),
        hasScratch: existsSync(join(dir, `${sid}.scratch.md`)),
        blobCount: countBlobs(sid, dir),
        ...shownTitle(readParsedSessionIndex(dir).titles.get(sid)),
      } satisfies SessionMetaView
    },

    async window(sid, opts) {
      if (!isSafeSid(sid)) return null
      const records = readRecords(sid, dir)
      if (records === null) return null
      return buildWindow(sid, records, opts, sb)
    },

    async toolCalls(sid, opts = {}) {
      if (!isSafeSid(sid)) return null
      const records = readRecords(sid, dir)
      if (records === null) return null
      const limit = clampInt(opts.limit, 1, 200, TOOLCALLS_DEFAULT_LIMIT)
      const offset = Math.max(0, opts.offset ?? 0)
      const newestFirst = opts.newestFirst ?? true

      const all: ToolCallHit[] = []
      for (let i = 0; i < records.length; i++) {
        const r = records[i]
        if (r.kind !== "assistant") continue
        for (const b of r.content) {
          if (b.type !== "tool_use") continue
          if (opts.tool && b.name !== opts.tool) continue
          all.push({
            index: i,
            ts: r.ts,
            tool: b.name,
            toolUseId: b.id ?? null,
            input: b.input,
            inputJson: tryJson(b.input),
            inputPreviewChars: TOOLCALL_INPUT_PREVIEW_CHARS,
          })
        }
      }
      const ordered = newestFirst ? [...all].reverse() : all
      return { hits: ordered.slice(offset, offset + limit), total: all.length }
    },

    async search(opts) {
      const limit = clampInt(opts.limit, 1, 200, SEARCH_DEFAULT_LIMIT)
      const offset = Math.max(0, opts.offset ?? 0)
      const previewChars = Math.max(PREVIEW_MIN_CHARS, opts.previewChars ?? 160)
      const needle = opts.query.toLowerCase()
      if (needle.length === 0) return { hits: [], total: 0, scannedSessions: 0 }

      const sids = opts.sid
        ? isSafeSid(opts.sid)
          ? [opts.sid]
          : []
        : readIndex(dir)
            .map((e) => e.sid)
            .reverse()
            .slice(0, clampInt(opts.maxSessions, 1, 50, SEARCH_DEFAULT_MAX_SESSIONS))

      const all: SearchHit[] = []
      let scanned = 0
      for (const sid of sids) {
        const records = readRecords(sid, dir)
        if (records === null) continue
        scanned++
        for (let i = 0; i < records.length; i++) {
          const r = records[i]
          const parts = recordBodyParts(r, sb)
          const body = joinBody(parts, opts.renderBody)
          const at = body.toLowerCase().indexOf(needle)
          if (at < 0) continue
          all.push({
            sid,
            index: i,
            ts: recordTs(r),
            kind: r.kind,
            parts,
            matchAt: at,
            matchLength: needle.length,
            previewChars,
          })
        }
      }
      return {
        hits: all.slice(offset, offset + limit),
        total: all.length,
        scannedSessions: scanned,
      }
    },

    async records(sid) {
      if (!isSafeSid(sid)) return null
      if (!existsSync(sessionFilePath(sid, dir))) return null
      // The sideband finds an old unmarked compaction checkpoint (design step 8).
      const loaded = loadSession(sid, dir, { sideband: sb })
      return { sid, meta: loaded.meta, records: loaded.records, messages: loaded.messages }
    },
  }
}

// ---------------------------------------------------------------------------
// Window building (exported for the host's --dump-adjacent reuse + tests)
// ---------------------------------------------------------------------------

/**
 * Pure: fold parsed records into a stable-index {@link RecordWindow}.
 * `sb` finds the runtime attachment blocks (see {@link recordBodyParts}).
 */
export function buildWindow(
  sid: string,
  records: readonly SessionRecord[],
  opts: WindowOpts,
  sb: SidebandReader = NO_SIDEBAND,
): RecordWindow {
  const limit = clampInt(opts.limit, 1, WINDOW_MAX_LIMIT, WINDOW_DEFAULT_LIMIT)
  const offset = Math.max(0, opts.offset ?? 0)
  const previewChars = Math.max(PREVIEW_MIN_CHARS, opts.previewChars ?? PREVIEW_DEFAULT_CHARS)

  let start: number
  if (opts.anchor === "end") {
    start = Math.max(0, records.length - offset - limit)
  } else {
    start = Math.min(offset, records.length)
  }
  const end =
    opts.anchor === "end"
      ? Math.max(0, records.length - offset)
      : Math.min(records.length, start + limit)

  const items: RecordView[] = []
  for (let i = start; i < end; i++) {
    items.push(toRecordView(records[i], i, previewChars, sb))
  }
  return {
    sid,
    items,
    total: records.length,
    firstIndex: items.length > 0 ? items[0].index : null,
    lastIndex: items.length > 0 ? items[items.length - 1].index : null,
  }
}

/** Pure: one record → its bounded {@link RecordView} DTO. `sb`: see {@link recordBodyParts}. */
export function toRecordView(
  r: SessionRecord,
  index: number,
  previewChars: number,
  sb: SidebandReader = NO_SIDEBAND,
): RecordView {
  return {
    index,
    userId: r.kind === "user" ? (r.id ?? null) : null,
    kind: r.kind,
    ts: recordTs(r),
    previewChars,
    parts: recordBodyParts(r, sb),
    facts: recordFacts(r),
  }
}

/** Pure: raw first-prompt pieces, or null when there is no user record. */
function firstPromptParts(records: readonly SessionRecord[]): string[] | null {
  for (const r of records) {
    if (r.kind !== "user") continue
    if (typeof r.content === "string") return [r.content]
    return r.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text)
  }
  return null
}

/** Default body: the raw part texts joined by a newline, or the host-supplied renderer. */
function joinBody(
  parts: readonly BodyPart[],
  render: ((parts: readonly BodyPart[]) => string) | undefined,
): string {
  return render ? render(parts) : parts.map((p) => p.text).join("\n")
}

function tryJson(v: unknown): string | null {
  try {
    return JSON.stringify(v) ?? "null"
  } catch {
    return null
  }
}

function partsOfBlocks(blocks: readonly ContentBlock[], sb: SidebandReader): BodyPart[] {
  const out: BodyPart[] = []
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        if (b.sideband !== undefined || isRuntimeAttachmentText(b.text, sb)) break
        out.push({ kind: "text", text: b.text, toolName: null })
        break
      case "thinking":
        if (b.thinking) out.push({ kind: "thinking", text: b.thinking, toolName: null })
        break
      case "tool_use":
        // On purpose: core holds no text. An unserializable input gives "" here, and the plugin supplies the text for a null inputJson.
        out.push({ kind: "tool_use", text: tryJson(b.input) ?? "", toolName: b.name })
        break
      case "tool_result": {
        const inner =
          typeof b.content === "string"
            ? b.content
            : b.content
                .filter((x): x is TextBlock => x.type === "text")
                .map((x) => x.text)
                .join("\n")
        out.push({ kind: "tool_result", text: inner, toolName: null })
        break
      }
      default:
        break
    }
  }
  return out
}

function partsOfContent(content: string | ContentBlock[], sb: SidebandReader): BodyPart[] {
  if (typeof content === "string") return [{ kind: "text", text: content, toolName: null }]
  return partsOfBlocks(content, sb)
}

/**
 * Pure: structured pieces of the body (raw text per piece, no added text).
 * A runtime attachment text block is left out: a block with a `sideband`
 * mark, or a text that `sb` reads as a harness tag at its start. With
 * `NO_SIDEBAND` (the default) only a marked block is left out.
 */
export function recordBodyParts(r: SessionRecord, sb: SidebandReader = NO_SIDEBAND): BodyPart[] {
  switch (r.kind) {
    case "user":
    case "tool_result":
      return partsOfContent(r.content, sb)
    case "assistant":
      return partsOfBlocks(r.content, sb)
    case "note":
      return [{ kind: "text", text: r.text, toolName: null }]
    case "compact":
      return r.replacementMessages.map((m) => ({
        kind: "message",
        text: String(m.content),
        toolName: null,
        role: m.role,
      }))
    case "meta":
    case "rewind":
    case "history_edit":
    case "round_checkpoint":
    case "target_switch":
    case "attach":
    case "detach":
      return []
    default:
      return [{ kind: "raw", text: JSON.stringify(r satisfies never), toolName: null }]
  }
}

/** Pure: raw kind-specific values behind a record summary. */
export function recordFacts(r: SessionRecord): RecordFacts {
  const f = {
    contentIsString: null as boolean | null,
    toolResultCount: 0,
    textBlockCount: 0,
    blockCount: 0,
    toolNames: [] as string[],
    hasText: false,
    stopReason: null as string | null,
    isError: null as boolean | null,
    toolUseId: null as string | null,
    model: null as string | null,
    cwd: null as string | null,
    compactKind: null as string | null,
    reason: null as string | null,
    messagesBefore: null as number | null,
    messagesAfter: null as number | null,
    rewindTo: null as string | null,
    droppedCount: null as number | null,
    backupSid: null as string | null,
    droppedRecordCount: null as number | null,
    pid: null as number | null,
    hostname: null as string | null,
    round: null as number | null,
  }
  switch (r.kind) {
    case "meta":
      f.model = r.model
      f.cwd = r.cwd
      break
    case "user":
      f.contentIsString = typeof r.content === "string"
      if (typeof r.content !== "string") {
        f.toolResultCount = r.content.filter((b) => b.type === "tool_result").length
        f.textBlockCount = r.content.filter((b) => b.type === "text").length
        f.blockCount = r.content.length
      }
      break
    case "assistant":
      f.toolNames = r.content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((t) => t.name)
      f.hasText = r.content.some((b) => b.type === "text")
      f.stopReason = r.stopReason === undefined ? null : r.stopReason
      break
    case "tool_result":
      f.isError = r.isError
      f.toolUseId = r.tool_use_id
      break
    case "compact":
      f.compactKind = r.compactKind
      f.reason = r.reason
      f.messagesBefore = r.messagesBefore
      f.messagesAfter = r.messagesAfter
      break
    case "rewind":
      f.rewindTo = r.to
      f.droppedCount = r.droppedCount
      break
    case "history_edit":
      f.backupSid = r.backupSid
      f.droppedRecordCount = r.droppedRecordCount
      break
    case "attach":
      f.pid = r.pid
      f.hostname = r.hostname
      break
    case "detach":
      f.pid = r.pid
      f.reason = r.reason
      break
    case "round_checkpoint":
      f.round = r.round
      break
    case "target_switch":
      f.model = r.model
      break
    default:
      break
  }
  return f
}

// ---------------------------------------------------------------------------
// Record shaping helpers (pure)
// ---------------------------------------------------------------------------

function recordTs(r: SessionRecord): string | null {
  if (r.kind === "meta") return r.createdAt
  return r.ts ?? null
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function clampInt(v: number | undefined, min: number, max: number, dflt: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt
  return Math.min(max, Math.max(min, Math.trunc(v)))
}

function readIndex(dir: string): IndexRecord[] {
  // Session lines of `index.jsonl`, with the tombstones of both index files
  // applied. Summary and tombstone lines are not sessions (session-catalog).
  return liveSessions(readParsedSessionIndex(dir).sessions, dir)
}

/**
 * The saved title of `sid` that the catalog shows (user, then ai, then derived; an
 * empty title is skipped). No saved title → `{}` (no new key in the view).
 */
function shownTitle(state?: SessionTitleState): { title?: string; titleSource?: TitleSource } {
  for (const source of ["user", "ai", "derived"] as const) {
    const title = state?.[source]?.title
    if (title) return { title, titleSource: source }
  }
  return {}
}

/** The session lines whose session file exists. */
function liveSessions(sessions: readonly IndexRecord[], dir: string): IndexRecord[] {
  return sessions.filter((rec) => {
    try {
      return existsSync(sessionFilePath(rec.sid, dir))
    } catch {
      return false
    }
  })
}

/** Parse a session's records, or `null` when the sid has no file. */
function readRecords(sid: string, dir: string): SessionRecord[] | null {
  let text: string
  try {
    text = readFileSync(sessionFilePath(sid, dir), "utf-8")
  } catch {
    return null
  }
  return parseLines(text).records
}

function countBlobs(sid: string, dir: string): number {
  try {
    return readdirSync(join(dir, `${sid}.blobs`)).filter((n) => n.endsWith(".raw")).length
  } catch {
    return 0
  }
}

/** Map the host's `Liveness` union onto the capability DTO. */
function toSessionLiveness(l: Liveness): SessionLiveness {
  switch (l.status) {
    case "live":
      return { status: "live", source: "pid", pid: l.pid, since: l.since }
    case "dead":
      return { status: "dead", source: "pid", reason: l.reason }
    case "unknown":
      return { status: "unknown", source: "pid", reason: l.reason }
    default: {
      throw new Error(`unhandled liveness: ${JSON.stringify(l satisfies never)}`)
    }
  }
}

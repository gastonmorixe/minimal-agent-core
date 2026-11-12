/**
 * `sessions:read` capability provider — the host-side adapter that
 * implements {@link SessionsReadApi} over the session store
 * (`src/session-store.ts`, `src/session-restore.ts`, `src/session-dump.ts`,
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
import { formatSessionAsMarkdown, formatSessionAsXml } from "../../../session/session-dump.ts"
import { getSessionLiveness, type Liveness } from "../../../session/session-liveness.ts"
import { firstUserPromptSnippet, loadSession } from "../../../session/session-restore.ts"
import {
  defaultSessionsDir,
  type IndexRecord,
  indexFilePath,
  type MetaRecord,
  parseLines,
  type SessionRecord,
  sessionFilePath,
} from "../../../session/session-store.ts"
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
}

const TOOLCALL_INPUT_PREVIEW_CHARS = 200
const FIRST_PROMPT_CHARS = 100

/** Build the host-side `sessions:read` implementation. */
export function createSessionsReadApi(deps: SessionsReadDeps = {}): SessionsReadApi {
  const dir = deps.dir ?? defaultSessionsDir()

  return {
    async list(opts = {}) {
      const limit = clampInt(opts.limit, 1, 200, LIST_DEFAULT_LIMIT)
      const offset = Math.max(0, opts.offset ?? 0)
      const all = readIndex(dir)
      const q = opts.query?.toLowerCase()
      const filtered = all.filter((e) => {
        if (opts.cwd && e.cwd !== opts.cwd) return false
        if (q && !(e.sid.toLowerCase().includes(q) || e.cwd.toLowerCase().includes(q))) return false
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
        firstPrompt: firstUserPromptSnippet(records, FIRST_PROMPT_CHARS) || null,
        firstPromptChars: FIRST_PROMPT_CHARS,
        firstPromptParts: firstPromptParts(records),
        lastActivity,
        liveness: toSessionLiveness(getSessionLiveness(sid, { dir })),
        modelChanges: [],
        hasTasks: existsSync(join(dir, `${sid}.tasks.jsonl`)),
        hasScratch: existsSync(join(dir, `${sid}.scratch.md`)),
        blobCount: countBlobs(sid, dir),
      } satisfies SessionMetaView
    },

    async window(sid, opts) {
      if (!isSafeSid(sid)) return null
      const records = readRecords(sid, dir)
      if (records === null) return null
      return buildWindow(sid, records, opts)
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
            inputPreview: clip(safeJson(b.input), TOOLCALL_INPUT_PREVIEW_CHARS).text,
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
          const body = recordBodyText(r)
          const at = body.toLowerCase().indexOf(needle)
          if (at < 0) continue
          all.push({
            sid,
            index: i,
            ts: recordTs(r),
            kind: r.kind,
            preview: contextSnippet(body, at, needle.length, previewChars),
            parts: recordBodyParts(r),
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

    async dump(sid, opts = {}) {
      if (!isSafeSid(sid)) return null
      if (!existsSync(sessionFilePath(sid, dir))) return null
      const loaded = loadSession(sid, dir)
      const text =
        opts.format === "xml" ? formatSessionAsXml(loaded) : formatSessionAsMarkdown(loaded)
      return { text, bytes: Buffer.byteLength(text, "utf8") }
    },
  }
}

// ---------------------------------------------------------------------------
// Window building (exported for the host's --dump-adjacent reuse + tests)
// ---------------------------------------------------------------------------

/** Pure: fold parsed records into a stable-index {@link RecordWindow}. */
export function buildWindow(
  sid: string,
  records: readonly SessionRecord[],
  opts: WindowOpts,
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
    items.push(toRecordView(records[i], i, previewChars))
  }
  return {
    sid,
    items,
    total: records.length,
    firstIndex: items.length > 0 ? items[0].index : null,
    lastIndex: items.length > 0 ? items[items.length - 1].index : null,
  }
}

/** Pure: one record → its bounded {@link RecordView} DTO. */
export function toRecordView(r: SessionRecord, index: number, previewChars: number): RecordView {
  const body = recordBodyText(r)
  const { text, clipped } = clip(body, previewChars)
  return {
    index,
    userId: r.kind === "user" ? (r.id ?? null) : null,
    kind: r.kind,
    ts: recordTs(r),
    summary: summarizeRecord(r),
    preview: text,
    clipped,
    fullChars: body.length,
    previewChars,
    parts: recordBodyParts(r),
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

function tryJson(v: unknown): string | null {
  try {
    return JSON.stringify(v) ?? "null"
  } catch {
    return null
  }
}

function partsOfBlocks(blocks: readonly ContentBlock[]): BodyPart[] {
  const out: BodyPart[] = []
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        if (isRuntimeAttachmentText(b.text)) break
        out.push({ kind: "text", text: b.text, toolName: null })
        break
      case "thinking":
        if (b.thinking) out.push({ kind: "thinking", text: b.thinking, toolName: null })
        break
      case "tool_use":
        out.push({ kind: "tool_use", text: safeJson(b.input), toolName: b.name })
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

function partsOfContent(content: string | ContentBlock[]): BodyPart[] {
  if (typeof content === "string") return [{ kind: "text", text: content, toolName: null }]
  return partsOfBlocks(content)
}

/**
 * Pure: structured pieces of the body. {@link recordBodyText} equals the
 * newline join of the pieces after the plugin re-adds the prefix per kind
 * ("[thinking] ", "[tool_use <toolName>] ", "<role>: " for "message").
 */
export function recordBodyParts(r: SessionRecord): BodyPart[] {
  switch (r.kind) {
    case "user":
    case "tool_result":
      return partsOfContent(r.content)
    case "assistant":
      return partsOfBlocks(r.content)
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
    case "attach":
    case "detach":
      return []
    default:
      return [{ kind: "raw", text: JSON.stringify(r satisfies never), toolName: null }]
  }
}

/** Pure: raw kind-specific values behind {@link summarizeRecord}. */
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

/** Compact role/summary line, e.g. `assistant · 2 tool_use (Bash, Read)`. */
export function summarizeRecord(r: SessionRecord): string {
  switch (r.kind) {
    case "meta":
      return `meta · model ${r.model} · cwd ${r.cwd}`
    case "user": {
      if (typeof r.content === "string") return "user · text"
      const results = r.content.filter((b) => b.type === "tool_result").length
      const texts = r.content.filter((b) => b.type === "text").length
      const parts: string[] = []
      if (results > 0) parts.push(`${results} tool_result`)
      if (texts > 0) parts.push("text")
      return `user · ${parts.length > 0 ? parts.join(" + ") : `${r.content.length} block(s)`}`
    }
    case "assistant": {
      const tools = r.content.filter((b): b is ToolUseBlock => b.type === "tool_use")
      const hasText = r.content.some((b) => b.type === "text")
      const bits: string[] = []
      if (hasText) bits.push("text")
      if (tools.length > 0) {
        bits.push(`${tools.length} tool_use (${tools.map((t) => t.name).join(", ")})`)
      }
      const stop = r.stopReason ? ` · stop=${r.stopReason}` : ""
      return `assistant · ${bits.length > 0 ? bits.join(" + ") : "(empty)"}${stop}`
    }
    case "tool_result":
      return `tool_result · ${r.isError ? "ERROR" : "ok"} · id ${r.tool_use_id}`
    case "note":
      return "note"
    case "compact":
      return `compact · ${r.compactKind} · ${r.reason} · ${r.messagesBefore}→${r.messagesAfter}`
    case "rewind":
      return `rewind · to ${r.to} · dropped ${r.droppedCount}`
    case "history_edit":
      return `history edit · backup ${r.backupSid} · dropped ${r.droppedRecordCount}`
    case "attach":
      return `attach · pid ${r.pid} on ${r.hostname}`
    case "detach":
      return `detach · pid ${r.pid} · ${r.reason}`
    case "round_checkpoint":
      return `round checkpoint · round ${r.round}`
    default: {
      return `unknown · ${JSON.stringify(r satisfies never)}`
    }
  }
}

/** Full body text for previews + search (pre-clip). */
export function recordBodyText(r: SessionRecord): string {
  switch (r.kind) {
    case "meta":
      return ""
    case "user":
      return contentToText(r.content)
    case "assistant":
      return blocksToText(r.content)
    case "tool_result":
      return contentToText(r.content)
    case "note":
      return r.text
    case "compact":
      return r.replacementMessages.map((m) => `${m.role}: ${m.content}`).join("\n")
    case "rewind":
    case "history_edit":
    case "round_checkpoint":
    case "attach":
    case "detach":
      return ""
    default: {
      return JSON.stringify(r satisfies never)
    }
  }
}

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return blocksToText(content)
}

function blocksToText(blocks: ContentBlock[]): string {
  const parts: string[] = []
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        // Skip runtime attachment blocks the agent prepends to user
        // messages (tasks, scratchpad, save echoes, mode toggles,
        // reflection checkpoints, sub-agents digest).  These carry
        // model-facing context and must not leak into SessionHistory
        // previews or the TUI scrollback.  See runtime-attachments.ts
        // (canonical definition shared with session-replay.ts).
        if (isRuntimeAttachmentText(b.text)) break
        parts.push(b.text)
        break
      case "thinking":
        if (b.thinking) parts.push(`[thinking] ${b.thinking}`)
        break
      case "tool_use":
        parts.push(`[tool_use ${b.name}] ${safeJson(b.input)}`)
        break
      case "tool_result": {
        const inner =
          typeof b.content === "string"
            ? b.content
            : b.content
                .filter((x): x is TextBlock => x.type === "text")
                .map((x) => x.text)
                .join("\n")
        parts.push(inner)
        break
      }
      default:
        // image / document / redacted_thinking — not text-searchable.
        break
    }
  }
  return parts.join("\n")
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function clampInt(v: number | undefined, min: number, max: number, dflt: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt
  return Math.min(max, Math.max(min, Math.trunc(v)))
}

function clip(s: string, max: number): { text: string; clipped: boolean } {
  if (s.length <= max) return { text: s, clipped: false }
  return { text: `${s.slice(0, max - 1)}…`, clipped: true }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null"
  } catch {
    return "[unserializable]"
  }
}

/** Window a search hit's surroundings so the match is visible in context. */
function contextSnippet(body: string, at: number, matchLen: number, budget: number): string {
  const lead = Math.floor((budget - matchLen) / 2)
  const start = Math.max(0, at - lead)
  const end = Math.min(body.length, start + budget)
  const core = body.slice(start, end).replace(/\s+/g, " ").trim()
  return `${start > 0 ? "…" : ""}${core}${end < body.length ? "…" : ""}`
}

function readIndex(dir: string): IndexRecord[] {
  let text: string
  try {
    text = readFileSync(indexFilePath(dir), "utf-8")
  } catch {
    return []
  }
  const out: IndexRecord[] = []
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    try {
      const rec = JSON.parse(line) as IndexRecord
      if (!existsSync(sessionFilePath(rec.sid, dir))) continue
      out.push(rec)
    } catch {
      // best-effort index
    }
  }
  return out
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

import { existsSync, readFileSync } from "node:fs"

import { isSafeSessionId } from "./session-id-safety.ts"
import {
  defaultSessionsDir,
  type IndexLineageRecord,
  type IndexRecord,
  type IndexSummaryRecord,
  indexFilePath,
  indexMetaFilePath,
  isIndexLineageRecord,
  isIndexSummaryRecord,
  isIndexTombstoneRecord,
  sessionFilePath,
} from "./session-store.ts"
import {
  type IndexTitleRecord,
  isIndexTitleRecord,
  type SessionTitleState,
} from "./session-title.ts"

/** The lines of `index.jsonl` and `index-meta.jsonl`, split by kind. */
export interface ParsedSessionIndex {
  /** Session lines in append order (oldest first). Summary lines are not here. */
  sessions: IndexRecord[]
  /** The last summary line of each sid (last one wins). */
  summaries: Map<string, IndexSummaryRecord>
  /**
   * The last sidecar lineage line of each sid that a tombstone does not
   * remove (also when the session line has a recorded `leadSid`, so the
   * backfill can see what is already written).
   */
  lineages: Map<string, IndexLineageRecord>
  /**
   * The title state of each sid from the sidecar `kind: "title"` lines: the
   * last line of each source (`user`, `ai`, `derived`) that a tombstone does
   * not remove. A sid with no title is not in the map. An empty last `user`
   * line means "no user title": `user` is then absent.
   */
  titles: Map<string, SessionTitleState>
}

/**
 * True when a session line has the fields that the readers use: a safe
 * `sid` (see `isSafeSessionId`), and string `createdAt`, `cwd` and `model`.
 * A line that fails this check is skipped, so one bad line cannot make a
 * listing throw.
 */
function isValidSessionLine(rec: object): rec is IndexRecord {
  const r = rec as Partial<Record<keyof IndexRecord, unknown>>
  return (
    typeof r.sid === "string" &&
    isSafeSessionId(r.sid) &&
    typeof r.createdAt === "string" &&
    typeof r.cwd === "string" &&
    typeof r.model === "string"
  )
}

/** One JSON object line with a string `sid`, or `undefined`. */
function parseLine(line: string): (object & { sid: string }) | undefined {
  if (line.length === 0) return undefined
  let rec: unknown
  try {
    rec = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof rec !== "object" || rec === null) return undefined
  if (typeof (rec as { sid?: unknown }).sid !== "string") return undefined
  return rec as object & { sid: string }
}

/** A line with its line number (`at`) and its start offset in bytes (`off`). */
interface Placed<T> {
  rec: T
  at: number
  off: number
}

/** The last title line of each source of one sid, with its line number. */
type PlacedTitles = Partial<
  Record<IndexTitleRecord["source"], { rec: IndexTitleRecord; at: number }>
>

/** The summary, lineage, title and tombstone lines of `index-meta.jsonl`. */
interface MetaLines {
  summaries: Map<string, Placed<IndexSummaryRecord>>
  lineages: Map<string, Placed<IndexLineageRecord>>
  titles: Map<string, PlacedTitles>
  /** The last tombstone of each sid: its line, and the `indexBytes` cut. */
  tombstones: Map<string, { at: number; indexBytes: number | undefined }>
}

function parseMetaText(text: string): MetaLines {
  const summaries = new Map<string, Placed<IndexSummaryRecord>>()
  const lineages = new Map<string, Placed<IndexLineageRecord>>()
  const titles = new Map<string, PlacedTitles>()
  const tombstones = new Map<string, { at: number; indexBytes: number | undefined }>()
  let at = 0
  for (const line of text.split("\n")) {
    at += 1
    const rec = parseLine(line)
    if (rec === undefined) continue
    if (isIndexSummaryRecord(rec)) summaries.set(rec.sid, { rec, at, off: 0 })
    else if (isIndexLineageRecord(rec)) lineages.set(rec.sid, { rec, at, off: 0 })
    else if (isIndexTitleRecord(rec)) {
      // Last line wins per (sid, source), in file order.
      const own = titles.get(rec.sid)
      if (own) own[rec.source] = { rec, at }
      else titles.set(rec.sid, { [rec.source]: { rec, at } })
    } else if (isIndexTombstoneRecord(rec)) {
      const cut = rec.indexBytes
      tombstones.set(rec.sid, {
        at,
        indexBytes: typeof cut === "number" && Number.isFinite(cut) ? cut : undefined,
      })
    }
  }
  return { summaries, lineages, titles, tombstones }
}

/**
 * The title state of one sid: the last line of each source that comes after
 * the last sidecar tombstone of the sid (`cutAt`, 0 when none). An empty
 * `user` title is "no user title". `undefined` when no source is left.
 */
function titleState(placed: PlacedTitles, cutAt: number): SessionTitleState | undefined {
  let out: SessionTitleState | undefined
  for (const source of ["user", "ai", "derived"] as const) {
    const p = placed[source]
    if (p === undefined || p.at <= cutAt) continue
    if (source === "user" && p.rec.title.length === 0) continue
    out ??= {}
    out[source] = p.rec
  }
  return out
}

/**
 * The row with the lineage of a sidecar line, when the session line has no
 * recorded `leadSid` (recorded lineage always wins). Else the row itself.
 */
function withLineage(rec: IndexRecord, line: IndexLineageRecord | undefined): IndexRecord {
  if (line === undefined || rec.leadSid) return rec
  return {
    ...rec,
    leadSid: line.leadSid,
    ...(line.agentId && !rec.agentId ? { agentId: line.agentId } : {}),
    ...(line.role && !rec.role ? { role: line.role } : {}),
    lineageSource: line.source,
  }
}

/**
 * Parse the text of `index.jsonl` and (optional) `index-meta.jsonl`. Pure:
 * no file access, no `existsSync`.
 *
 * `index.jsonl`: malformed lines, lines with no string `sid`, and session
 * lines that fail the field check (unsafe sid; `createdAt`, `cwd` or
 * `model` not a string) are skipped. Older builds of this version also
 * wrote `kind: "summary"` and `kind: "tombstone"` lines here; they are
 * still read: a summary line goes to `summaries` (the last line of a sid
 * wins), and a tombstone removes the earlier session and summary lines of
 * its sid (line order).
 *
 * `index-meta.jsonl` (the sidecar, see `indexMetaFilePath`): summary,
 * lineage, title and tombstone lines only. A title line (see
 * `isIndexTitleRecord`; an unknown `v` is skipped) goes to `titles`: the
 * last line of each `(sid, source)` wins; the same two tombstone rules as
 * for sidecar summaries apply. A lineage line (the last one of a sid
 * wins) fills `leadSid`, `agentId`, `role` and `lineageSource` of the
 * session lines of its sid that have no recorded `leadSid`; a sidecar
 * tombstone removes the earlier lineage lines of its sid. A summary line here wins over a summary line in
 * `index.jsonl`; the last one of a sid wins. It is dropped when an
 * `index.jsonl` tombstone of its sid has no later session line. A tombstone here removes the
 * earlier sidecar summaries of its sid, the summary lines of its sid in
 * `index.jsonl`, and the session lines of its sid that start before its
 * `indexBytes` offset (all of them when `indexBytes` is absent). A later
 * session line of that sid (a re-used `--session-id`) is kept.
 *
 * @param text - The text of `index.jsonl`.
 * @param metaText - The text of `index-meta.jsonl`. Default `""`.
 */
export function parseSessionIndexText(text: string, metaText = ""): ParsedSessionIndex {
  const meta = parseMetaText(metaText)
  // Byte offsets are only necessary to apply a sidecar tombstone.
  const needOffsets = meta.tombstones.size > 0
  const sessions: Placed<IndexRecord>[] = []
  const summaries = new Map<string, Placed<IndexSummaryRecord>>()
  const tombstones = new Map<string, number>()
  let at = 0
  let off = 0
  for (const line of text.split("\n")) {
    at += 1
    const start = off
    if (needOffsets) off += Buffer.byteLength(line, "utf8") + 1
    const rec = parseLine(line)
    if (rec === undefined) continue
    if (isIndexSummaryRecord(rec)) summaries.set(rec.sid, { rec, at, off: start })
    else if (isIndexTombstoneRecord(rec)) tombstones.set(rec.sid, at)
    else if ((rec as { kind?: unknown }).kind === undefined && isValidSessionLine(rec)) {
      sessions.push({ rec, at, off: start })
    }
  }
  // An `index.jsonl` line is removed when a tombstone of its sid comes after
  // it in `index.jsonl`, or when a sidecar tombstone cuts it.
  const alive = (sid: string, line: Placed<unknown>): boolean => {
    if (line.at < (tombstones.get(sid) ?? 0)) return false
    const cut = meta.tombstones.get(sid)
    if (cut === undefined) return true
    return cut.indexBytes !== undefined && line.off >= cut.indexBytes
  }
  const out = new Map<string, IndexSummaryRecord>()
  for (const [sid, s] of summaries) if (alive(sid, s)) out.set(sid, s.rec)
  const kept = sessions.filter((s) => alive(s.rec.sid, s))
  // The two files have no common order. An `index.jsonl` tombstone (older
  // build) with no later session line of its sid: the session is gone, so
  // a sidecar summary of that sid is dropped too (at worst it is computed
  // again).
  const reused = new Set(kept.map((s) => s.rec.sid))
  for (const [sid, s] of meta.summaries) {
    if (tombstones.has(sid) && !reused.has(sid)) continue
    const cut = meta.tombstones.get(sid)
    if (cut === undefined || s.at > cut.at) out.set(sid, s.rec)
  }
  const lineages = new Map<string, IndexLineageRecord>()
  for (const [sid, l] of meta.lineages) {
    if (tombstones.has(sid) && !reused.has(sid)) continue
    const cut = meta.tombstones.get(sid)
    if (cut === undefined || l.at > cut.at) lineages.set(sid, l.rec)
  }
  // Title lines: the same two tombstone rules as sidecar summaries.
  const titles = new Map<string, SessionTitleState>()
  for (const [sid, placed] of meta.titles) {
    if (tombstones.has(sid) && !reused.has(sid)) continue
    const state = titleState(placed, meta.tombstones.get(sid)?.at ?? 0)
    if (state !== undefined) titles.set(sid, state)
  }
  return {
    sessions: kept.map((s) => withLineage(s.rec, lineages.get(s.rec.sid))),
    summaries: out,
    lineages,
    titles,
  }
}

/** Read a file as UTF-8; `""` when it is missing or cannot be read. */
function readTextOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return ""
  }
}

/**
 * Read and parse `index.jsonl` and its sidecar `index-meta.jsonl` from
 * `dir` (see {@link parseSessionIndexText}). Missing files give empty
 * results. Read only. No `existsSync` per row.
 *
 * @param dir - The sessions directory. Default `defaultSessionsDir()`.
 */
export function readParsedSessionIndex(dir: string = defaultSessionsDir()): ParsedSessionIndex {
  return parseSessionIndexText(
    readTextOrEmpty(indexFilePath(dir)),
    readTextOrEmpty(indexMetaFilePath(dir)),
  )
}

/**
 * Read the global sessions index. Returns one record per saved session,
 * in append order (oldest first). Missing index file → empty array.
 * Summary and tombstone lines are not sessions; tombstones in
 * `index.jsonl` and in the sidecar `index-meta.jsonl` are applied.
 *
 * Defensive filter: entries whose backing `<sid>.jsonl` no longer exists
 * on disk are dropped. The graceful-exit path in the host entry point keeps
 * the index and the JSONL log in sync (cleanup of an empty session appends
 * a tombstone line to `index-meta.jsonl`), but a SIGKILL, a manual `rm`, or
 * an older build can leave a stale row behind. Returning dead sids here
 * would mean `--sessions` lists phantoms and `--resume last` resolves to a
 * missing file. This filter is one `existsSync` per entry, cheap and
 * read-only.
 */
export function readSessionIndex(): IndexRecord[] {
  const dir = defaultSessionsDir()
  let text: string
  try {
    text = readFileSync(indexFilePath(dir), "utf-8")
  } catch {
    return []
  }
  // Malformed lines are skipped silently — the index is best-effort metadata.
  return parseSessionIndexText(text, readTextOrEmpty(indexMetaFilePath(dir))).sessions.filter(
    (rec) => {
      try {
        return existsSync(sessionFilePath(rec.sid))
      } catch {
        return false
      }
    },
  )
}

/**
 * Given a target string and session index records, try to resolve the target
 * to a full session id using prefix matching.
 *
 * Rules:
 * - Exactly one prefix match -\> return that sid.
 * - Multiple prefix matches with one exact match -\> return the exact match.
 * - Multiple prefix matches, no exact -\> return null (ambiguous).
 * - No prefix match -\> return target unchanged (pass-through so the caller's
 *   downstream lookup can produce a specific "no such session" error).
 */
export function resolveSidByPrefix(target: string, records: IndexRecord[]): string | null {
  const needle = target.toLowerCase()
  const matches = records.filter((e) => e.sid.toLowerCase().startsWith(needle))
  if (matches.length === 1) return matches[0].sid
  if (matches.length > 1) {
    const exact = matches.find((e) => e.sid.toLowerCase() === needle)
    if (exact) return exact.sid
    // Multiple prefix matches but none is an exact match -> ambiguous.
    return null
  }
  // No prefix match: pass through unchanged so the caller's downstream
  // lookup can produce a specific "no such session" error.
  return target
}

/**
 * Resolve `<sid|last>` to a concrete sid.
 *
 * Supports:
 * - `"last"` — the most recent session whose `cwd` matches the current process
 *   cwd; falls back to the global most recent.
 * - A short prefix (e.g. `"bc567526"`) — resolved against the session index
 *   using {@link resolveSidByPrefix}.
 * - A full sid — passes through unchanged.
 *
 * Returns `null` when "last" finds no sessions, or when a prefix is ambiguous
 * (multiple matches, none exact). On no prefix match at all, the target is
 * passed through unchanged so the caller's downstream filesystem lookup can
 * produce a specific error.
 */
export function resolveSessionTarget(target: string, cwd: string): string | null {
  if (target !== "last") {
    return resolveSidByPrefix(target, readSessionIndex())
  }
  return resolveLastSessionSid(readSessionIndex(), cwd)
}

/** Pure `--resume last` policy, exported for focused backup filtering tests. */
export function resolveLastSessionSid(records: readonly IndexRecord[], cwd: string): string | null {
  // Backups are explicitly resumable by sid, but must never win ordinary
  // `--resume last` selection because they represent discarded timelines.
  const all = records.filter((entry) => !entry.backup)
  if (all.length === 0) return null
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].cwd === cwd) return all[i].sid
  }
  return all[all.length - 1].sid
}

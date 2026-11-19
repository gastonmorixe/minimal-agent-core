/**
 * Fast session catalog: list saved sessions from the index only
 * (`index.jsonl` and its sidecar `index-meta.jsonl`).
 *
 * {@link listSessions} reads and parses the index one time. It does not read
 * a session file for a row that it does not return. A returned row with no
 * summary line gets one lazily: the catalog reads that one file, computes
 * the summary, and appends a `kind: "summary"` line to `index-meta.jsonl`,
 * so the next listing is fast.
 *
 * Rows are lead sessions, newest first. A sub-agent session (an index line
 * with `leadSid`) is attached to its lead as a child, not listed at the top
 * level. Empty sessions (0 turns), backups and test fixtures
 * (`00000000-…`) are hidden by default; the result gives their count.
 *
 * @module session-catalog
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"

import { parseSessionIndexText } from "./session-index.ts"
import { type LivenessDeps, livenessFromRecords } from "./session-liveness.ts"
import {
  defaultSessionsDir,
  INDEX_SUMMARY_VERSION,
  type IndexLineageSource,
  type IndexRecord,
  type IndexSummaryRecord,
  indexFilePath,
  indexMetaFilePath,
  type MetaRecord,
  parseLines,
  SUMMARY_ON_CLOSE_MAX_BYTES,
  sessionFilePath,
} from "./session-store.ts"
import {
  appendIndexSummary,
  computeSessionSummary,
  hasOpenAttach,
  type SessionSummary,
  toIndexSummaryRecord,
} from "./session-summary.ts"
import type { SessionTitleState, TitleSource } from "./session-title.ts"

/** Why a row is hidden by default. */
export type SessionHiddenReason =
  /** The session has 0 user turns. */
  | "empty"
  /** An archived timeline from a history edit (`backup: true`). */
  | "backup"
  /** A test fixture sid (`00000000-…`). */
  | "fixture"
  /** A sub-agent whose lead is not in the index (the lead row would hold it). */
  | "orphan-child"

/** File access of the catalog. Tests inject it to count the reads. */
export interface SessionCatalogIo {
  /** Read a whole file as UTF-8. Throws when the file is missing. */
  readFile(path: string): string
  /** True when the file exists. */
  exists(path: string): boolean
  /** The file size in bytes. Throws when the file is missing. */
  size(path: string): number
  /**
   * Optional: the file size and modification time (one `stat`). Throws when
   * the file is missing. When absent, the catalog uses {@link size} and
   * cannot see a stale summary line (N2).
   */
  stat?(path: string): { size: number; mtimeMs: number }
  /**
   * Append one summary line to the sidecar `index-meta.jsonl` (the first
   * argument is its path). Returns false on an error.
   */
  appendSummary(indexPath: string, line: IndexSummaryRecord): boolean
  /**
   * Optional: read the first `bytes` bytes of a file as UTF-8 (the fork
   * mark reads the `meta` record of a returned row). Throws when the file
   * is missing. When absent, rows with an index summary get no `forkOf`.
   */
  readHead?(path: string, bytes: number): string
}

/** Read the first `bytes` bytes of a file (one open, one read). */
function readHeadSync(path: string, bytes: number): string {
  const fd = openSync(path, "r")
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString("utf8")
  } finally {
    closeSync(fd)
  }
}

/** The default {@link SessionCatalogIo}: `node:fs`. */
export const defaultSessionCatalogIo: SessionCatalogIo = {
  readFile: (path) => readFileSync(path, "utf-8"),
  exists: (path) => existsSync(path),
  size: (path) => statSync(path).size,
  stat: (path) => {
    const st = statSync(path)
    return { size: st.size, mtimeMs: st.mtimeMs }
  },
  appendSummary: appendIndexSummary,
  readHead: readHeadSync,
}

/** Options of {@link listSessions}. */
export interface ListSessionsOptions {
  /** Rows per page. Default 30. */
  limit?: number
  /** Zero-based page. Default 0. */
  page?: number
  /**
   * Only sessions created at or after this time (ISO string, `Date`, or
   * epoch ms). A value that is not a valid time throws a `RangeError`.
   */
  since?: string | Date | number
  /** Only sessions with this exact `cwd`. */
  cwd?: string
  /** Only sessions whose model contains this text (case-insensitive). */
  model?: string
  /**
   * Case-insensitive substring on the title (the saved `user`, `ai` or
   * `derived` title, and the summary title), cwd, model and sid.
   */
  query?: string
  /** Also return hidden rows (with `hiddenReason`). Default false. */
  includeHidden?: boolean
  /** Sessions directory. Default `defaultSessionsDir()`. */
  dir?: string
  /**
   * Append the lazily computed summaries to `index-meta.jsonl`. Default true. Set
   * false for tests and dry runs: the catalog then writes nothing.
   */
  writeSummaries?: boolean
  /**
   * Do not read a session file larger than this to compute a summary
   * (`summarySource: "none"`). Default `SUMMARY_ON_CLOSE_MAX_BYTES` (8 MiB),
   * the same limit as the close path.
   */
  maxSummaryBytes?: number
  /** File access. Default {@link defaultSessionCatalogIo}. */
  io?: SessionCatalogIo
  /** Liveness probes (tests). Default: the real process probes. */
  liveness?: LivenessDeps
}

/** Where the summary of a row comes from. */
export type SessionSummarySource =
  /** A `kind: "summary"` line in `index-meta.jsonl` (or an old one in `index.jsonl`). */
  | "index"
  /** Computed in this call from the session file. */
  | "computed"
  /** No summary: the file is too large or cannot be read. */
  | "none"

/** One row of the catalog. */
export interface SessionCatalogRow {
  sid: string
  createdAt: string
  cwd: string
  model: string
  /** Lead session id when this is a sub-agent session. */
  leadSid?: string
  /** Sub-agent id given by the lead, for example `A2`. */
  agentId?: string
  /** Sub-agent role, for example `worker` or `explorer`. */
  role?: string
  /**
   * Where {@link leadSid} comes from: `recorded` (the index line), or a
   * backfilled sidecar lineage line (`transcript` or `ppid`, see
   * `backfillLineage`). Absent when the row has no `leadSid`.
   */
  lineageSource?: "recorded" | IndexLineageSource
  /**
   * The session that this session was forked or resumed from (meta
   * `parentSid`). Set only on returned rows. A fork is not a child: it
   * stays a top-level row.
   */
  forkOf?: string
  /** An archived timeline from a history edit. */
  backup?: boolean
  /** The session whose timeline this backup keeps. */
  backupOfSid?: string
  /** Title, tokens, cost, turns, end time and status. Absent when not known. */
  summary?: SessionSummary
  /** Where {@link summary} comes from. */
  summarySource: SessionSummarySource
  /**
   * The saved title from a sidecar title line, by the display order
   * user \> ai \> derived. Absent when the sid has no title line: then a
   * reader shows the first real prompt (`summary.title`, which stays the
   * first prompt). Display order: `title ?? summary.title`.
   */
  title?: string
  /** Where {@link title} comes from. Set only with {@link title}. */
  titleSource?: TitleSource
  /**
   * True when a process can still write this session (summary not final):
   * an open attach with a live pid, or no attach record and a last record
   * newer than one hour. Set only for computed summaries (also for a row
   * whose index line is stale: the file changed after it, N2).
   */
  live?: boolean
  /** Set only with `includeHidden`, on a row that is hidden by default. */
  hiddenReason?: SessionHiddenReason
  /**
   * Sub-agent sessions of this session, oldest first. A child row has its
   * own children (a sub-agent of a sub-agent), up to 8 levels. An orphan
   * row (`hiddenReason: "orphan-child"`) also has its children. An empty
   * child (0 turns) is here only with `includeHidden`.
   */
  children: SessionCatalogRow[]
}

/** The result of {@link listSessions}. */
export interface ListSessionsResult {
  /** The rows of the page, newest first, with their children. */
  rows: SessionCatalogRow[]
  /**
   * Number of top-level rows that match the filters and are not known to be
   * hidden (all matching rows with `includeHidden`). "Known" means: from the
   * index (fixture, backup, orphan, or a summary line with 0 turns). A row
   * whose session file is gone is not counted. The value comes from the
   * index at the start of the call, so it is the same for each page. When
   * {@link unknownCount} is above 0, `total` is an upper bound: some of
   * those rows can be empty.
   */
  total: number
  /**
   * Number of matching top-level rows that are known to be hidden (see
   * {@link total}), plus the empty (0 turns) children of the rows on this
   * page. `total` does not count children. When {@link unknownCount} is
   * above 0, this is a lower bound (the CLI can show `≥N hidden`).
   */
  hiddenCount: number
  /**
   * Number of top-level rows in {@link total} with no summary line in the
   * index: the catalog cannot know if they are empty without a file read.
   * 0 means `total` and `hiddenCount` are exact (for the top-level rows).
   */
  unknownCount: number
}

const FIXTURE_PREFIX = "00000000-"
const DEFAULT_LIMIT = 30
/** Same limit as the close path (P1 review m4): one shared constant. */
const DEFAULT_MAX_SUMMARY_BYTES = SUMMARY_ON_CLOSE_MAX_BYTES
/**
 * A session with no `attach` record whose last record is newer than this
 * can still be running (`runtime.openSession` writes no attach/detach), so
 * the catalog does not write its summary. A missing or bad time counts as old.
 */
const NO_ATTACH_LIVE_MS = 60 * 60 * 1000
/**
 * A session with no `attach` record (runtime/web: `runtime.openSession`
 * writes no attach/detach) gets a lazy summary line only when its last
 * record is older than this, and only when it has a turn (P1 review N3).
 * Before that, the catalog computes its summary on each listing.
 */
const NO_ATTACH_FINAL_MS = 24 * 60 * 60 * 1000
/**
 * A summary line is stale when the session file changed more than this
 * after the line's `endedAt` (P1 review N2: a resumed session that runs
 * now). The close path writes the line right after the last record.
 */
const STALE_SUMMARY_MARGIN_MS = 5_000
/** Deepest sub-agent level that is attached under its parent (lead = 0). */
const MAX_CHILD_DEPTH = 8

/**
 * Normalize `since` to an ISO string, or `undefined` when it is not given.
 * Throws a `RangeError` for a bad value: a silent "no filter" would list
 * all sessions (P1 review m8).
 */
function sinceIso(since: ListSessionsOptions["since"]): string | undefined {
  if (since === undefined) return undefined
  const ms =
    since instanceof Date ? since.getTime() : typeof since === "number" ? since : Date.parse(since)
  if (!Number.isFinite(ms)) throw new RangeError(`listSessions: bad since value: ${String(since)}`)
  return new Date(ms).toISOString()
}

/** The reason a record is hidden, from the index only (no file read). */
function indexHiddenReason(
  rec: IndexRecord,
  summary: IndexSummaryRecord | undefined,
): SessionHiddenReason | undefined {
  if (rec.sid.startsWith(FIXTURE_PREFIX)) return "fixture"
  if (rec.backup) return "backup"
  if (summary && summary.turns === 0) return "empty"
  return undefined
}

/** Merge duplicate session lines of one sid: the first line wins, later lines fill missing fields. */
function mergeSessions(lines: readonly IndexRecord[]): Map<string, IndexRecord> {
  const bySid = new Map<string, IndexRecord>()
  for (const rec of lines) {
    const prev = bySid.get(rec.sid)
    bySid.set(rec.sid, prev ? { ...rec, ...prev } : rec)
  }
  return bySid
}

/** Build a row from an index record and a summary. */
function baseRow(rec: IndexRecord): SessionCatalogRow {
  return {
    sid: rec.sid,
    createdAt: rec.createdAt,
    cwd: rec.cwd,
    model: rec.model,
    ...(rec.leadSid ? { leadSid: rec.leadSid } : {}),
    ...(rec.leadSid ? { lineageSource: rec.lineageSource ?? "recorded" } : {}),
    ...(rec.agentId ? { agentId: rec.agentId } : {}),
    ...(rec.role ? { role: rec.role } : {}),
    ...(rec.backup ? { backup: true } : {}),
    ...(rec.backupOfSid ? { backupOfSid: rec.backupOfSid } : {}),
    summarySource: "none",
    children: [],
  }
}

/** Newest first by `createdAt`, then by sid for a stable order. */
function newestFirst(a: IndexRecord, b: IndexRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  return a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0
}

/** Oldest first by `createdAt` (spawn order of children). */
function oldestFirst(a: IndexRecord, b: IndexRecord): number {
  return -newestFirst(a, b)
}

/** The context of one {@link listSessions} call. */
interface CatalogContext {
  dir: string
  /** The path of `index-meta.jsonl` (new summary lines go there). */
  metaPath: string
  io: SessionCatalogIo
  write: boolean
  maxBytes: number
  liveness: LivenessDeps | undefined
  summaries: Map<string, IndexSummaryRecord>
  /** The title state of each sid, from the sidecar title lines. */
  titles: Map<string, SessionTitleState>
  /** Session file mtimes from the count pass (no new syscall in `resolveRow`). */
  mtimes: Map<string, number>
  /** Sub-agent sids that are top-level orphan rows, not children. */
  orphans: Set<string>
}

/**
 * The saved title of a sid by the display order user \> ai \> derived, or
 * `undefined`. From the parsed sidecar only (no file read).
 */
function savedTitle(
  state: SessionTitleState | undefined,
): { title: string; source: TitleSource } | undefined {
  if (state === undefined) return undefined
  for (const source of ["user", "ai", "derived"] as const) {
    const title = state[source]?.title
    if (title) return { title, source }
  }
  return undefined
}

/**
 * Set `title` and `titleSource` of a resolved row from its saved title. A
 * row with no title line stays as it is (no new field).
 */
function fillTitle(row: SessionCatalogRow, ctx: CatalogContext): void {
  const saved = savedTitle(ctx.titles.get(row.sid))
  if (saved === undefined) return
  row.title = saved.title
  row.titleSource = saved.source
}

/** Set the row summary from an index summary line. Returns true. */
function useIndexSummary(row: SessionCatalogRow, known: IndexSummaryRecord): true {
  const { kind: _kind, sid: _sid, v: _v, ...summary } = known
  row.summary = summary
  row.summarySource = "index"
  return true
}

/**
 * True for an index summary line that the catalog must check again: an old
 * line (no `v`, or `v` below {@link INDEX_SUMMARY_VERSION}) with status
 * `failed`. Version 1 wrote `failed` for each dead session with no detach
 * record (a sub-agent worker that was SIGKILLed after it wrote its result).
 * Version 2 wrote `failed` for an exit by SIGHUP, SIGINT or SIGTERM (exit
 * code 129, 130, 143), for example a closed terminal tab (P1 review N1).
 */
function isSuspectSummary(known: IndexSummaryRecord): boolean {
  if (known.status !== "failed") return false
  return !(typeof known.v === "number" && known.v >= INDEX_SUMMARY_VERSION)
}

/**
 * True when the session file changed after the summary line was written
 * (N2): its mtime is newer than `endedAt` plus {@link STALE_SUMMARY_MARGIN_MS}.
 * For example a same-sid resume of a closed session, or a runtime/web
 * session that got new turns. The mtime of a top-level row comes from the
 * count pass; a child row gets one `stat` here (only when it has a line).
 * No mtime (an io with no `stat`), an empty file (0 bytes: no records, so
 * nothing newer than the line), or a bad `endedAt`: not stale.
 */
function isStaleSummary(sid: string, known: IndexSummaryRecord, ctx: CatalogContext): boolean {
  let mtime = ctx.mtimes.get(sid)
  if (mtime === undefined && ctx.io.stat) {
    try {
      const st = ctx.io.stat(sessionFilePath(sid, ctx.dir))
      mtime = st.size > 0 ? st.mtimeMs : Number.NaN
      ctx.mtimes.set(sid, mtime)
    } catch {
      return false
    }
  }
  if (mtime === undefined || Number.isNaN(mtime)) return false
  const ended = Date.parse(known.endedAt)
  return Number.isFinite(ended) && mtime > ended + STALE_SUMMARY_MARGIN_MS
}

/**
 * Fill the summary of one row. Index summary first; else read the file,
 * compute it, and (when allowed and the session is not live) append it.
 * Returns false when the session file is missing (a stale index line).
 */
/** Bytes of the head read for the fork mark (the `meta` record is first). */
const FORK_HEAD_BYTES = 4096

/**
 * Set `forkOf` from the `meta` record of the session file (first line), with
 * one head read. Only for returned rows whose file was not read for the
 * summary (a computed row has it from its records). Errors leave the row
 * as it is.
 */
function fillForkOf(row: SessionCatalogRow, ctx: CatalogContext): void {
  if (row.summarySource === "computed" || !ctx.io.readHead) return
  try {
    const head = ctx.io.readHead(sessionFilePath(row.sid, ctx.dir), FORK_HEAD_BYTES)
    const nl = head.indexOf("\n")
    if (nl === -1) return
    const meta = JSON.parse(head.slice(0, nl)) as { kind?: unknown; parentSid?: unknown }
    if (meta.kind === "meta" && typeof meta.parentSid === "string" && meta.parentSid !== row.sid) {
      row.forkOf = meta.parentSid
    }
  } catch {
    // No fork mark.
  }
}

function resolveRow(row: SessionCatalogRow, ctx: CatalogContext): boolean {
  let path: string
  try {
    path = sessionFilePath(row.sid, ctx.dir)
    if (!ctx.io.exists(path)) return false
  } catch {
    // An unsafe sid: treat it as a stale line.
    return false
  }
  const known = ctx.summaries.get(row.sid)
  const isStale = known !== undefined && isStaleSummary(row.sid, known, ctx)
  if (known && !isSuspectSummary(known) && !isStale) return useIndexSummary(row, known)
  try {
    if (ctx.io.size(path) > ctx.maxBytes) return known ? useIndexSummary(row, known) : true
    const { records } = parseLines(ctx.io.readFile(path))
    // A suspect old `failed` line is wrong only for D1 (an attach with no
    // detach after it) or N1 (a detach with a stop-signal exit code). Keep
    // it when the file has neither an open attach nor a detach record:
    // then the file has no evidence against it.
    if (known && !isStale && !hasOpenAttach(records) && !records.some((r) => r.kind === "detach")) {
      return useIndexSummary(row, known)
    }
    const meta = records.find((r): r is MetaRecord => r.kind === "meta")
    if (meta?.parentSid && meta.parentSid !== row.sid) row.forkOf = meta.parentSid
    const summary = computeSessionSummary(records, {
      modelId: meta?.model ?? row.model,
    })
    // A dead process with no detach record (pid-gone, pid-reused) keeps the
    // status from the records (`done`): sub-agent workers are SIGKILLed
    // after they write their result, so a missing detach is not a failure.
    const live = livenessFromRecords(records, ctx.liveness)
    // No attach record and a recent last record: a runtime/web session that
    // never writes attach/detach can still be running. Treat it as live.
    const recentNoAttach =
      live.status === "dead" &&
      live.reason === "no-attach" &&
      Date.now() - Date.parse(summary.endedAt) < NO_ATTACH_LIVE_MS
    row.summary = summary
    row.summarySource = "computed"
    row.live = live.status !== "dead" || recentNoAttach
    // N3: a no-attach session has no end record, so a line is final only
    // when it is old and has a turn. Else an idle web session with 0 turns
    // would be hidden as `empty` for all time.
    // A file with no records (no meta) was never opened by a runtime: final.
    const noAttach = live.status === "dead" && live.reason === "no-attach" && records.length > 0
    const noAttachFinal =
      !noAttach ||
      (summary.turns > 0 && Date.now() - Date.parse(summary.endedAt) > NO_ATTACH_FINAL_MS)
    if (ctx.write && live.status === "dead" && !recentNoAttach && noAttachFinal) {
      const line = toIndexSummaryRecord(row.sid, summary)
      // A file whose mtime is far after its last record (for example a
      // copied or touched file) would give a stale line again on each call:
      // do not write it, so the sidecar does not grow on each listing.
      if (isStaleSummary(row.sid, line, ctx)) return true
      if (ctx.io.appendSummary(ctx.metaPath, line)) ctx.summaries.set(row.sid, line)
    }
  } catch {
    // Unreadable file: keep the index summary, or the row with no summary.
    if (known) return useIndexSummary(row, known)
  }
  return true
}

/**
 * List saved sessions from the index, newest first, one page at a time.
 *
 * Cost: one read and parse of `index.jsonl` and `index-meta.jsonl`; one `stat` for each matching
 * top-level row (for the counts); then (when the index
 * has no summary) one session-file read for the rows of pages 0..`page`
 * and the children of the returned rows; and one 4 KiB head read (the
 * `meta` record, for `forkOf`) for each returned row that has an index
 * summary. The counts do not depend on the page, and a row is never on two
 * pages.
 *
 * Filters (`since`, `cwd`, `model`, `query`) apply to the top-level rows.
 * `query` matches the saved title (a sidecar title line) and the summary
 * title; the summary title only when the index has a summary for the row.
 * Each returned row gets `title` and `titleSource` (see
 * {@link SessionCatalogRow.title}); a title line does not change the hidden
 * rule, the counts or the liveness.
 *
 * @param opts - See {@link ListSessionsOptions}.
 * @returns The page rows, the visible total, and the hidden count.
 */
export function listSessions(opts: ListSessionsOptions = {}): ListSessionsResult {
  const dir = opts.dir ?? defaultSessionsDir()
  const io = opts.io ?? defaultSessionCatalogIo
  const indexPath = indexFilePath(dir)
  const limit = Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT))
  const page = Math.max(0, Math.trunc(opts.page ?? 0))
  const includeHidden = opts.includeHidden === true
  // First: a bad `since` throws also when the index is missing.
  const since = sinceIso(opts.since)

  let text: string
  try {
    text = io.readFile(indexPath)
  } catch {
    return { rows: [], total: 0, hiddenCount: 0, unknownCount: 0 }
  }
  const metaPath = indexMetaFilePath(dir)
  let metaText = ""
  try {
    metaText = io.readFile(metaPath)
  } catch {
    // No sidecar yet.
  }
  const parsed = parseSessionIndexText(text, metaText)
  const bySid = mergeSessions(parsed.sessions)
  const ctx: CatalogContext = {
    dir,
    metaPath,
    io,
    write: opts.writeSummaries !== false,
    maxBytes: opts.maxSummaryBytes ?? DEFAULT_MAX_SUMMARY_BYTES,
    liveness: opts.liveness,
    summaries: parsed.summaries,
    titles: parsed.titles,
    mtimes: new Map(),
    orphans: new Set(),
  }

  // Children by lead, and the top-level candidates.
  const childrenByLead = new Map<string, IndexRecord[]>()
  const tops: { rec: IndexRecord; orphan: boolean }[] = []
  for (const rec of bySid.values()) {
    if (rec.leadSid && rec.leadSid !== rec.sid) {
      const list = childrenByLead.get(rec.leadSid)
      if (list) list.push(rec)
      else childrenByLead.set(rec.leadSid, [rec])
      if (leadRoot(rec, bySid) === "orphan") {
        tops.push({ rec, orphan: true })
        ctx.orphans.add(rec.sid)
      }
    } else {
      tops.push({ rec, orphan: false })
    }
  }

  // Filters on the top-level rows (index data only).
  const model = opts.model?.trim().toLowerCase() || undefined
  const query = opts.query?.trim().toLowerCase() || undefined
  const matches = (rec: IndexRecord): boolean => {
    if (since !== undefined && !(rec.createdAt >= since)) return false
    if (opts.cwd !== undefined && rec.cwd !== opts.cwd) return false
    if (model !== undefined && !rec.model.toLowerCase().includes(model)) return false
    if (query !== undefined) {
      const known = ctx.summaries.get(rec.sid)?.title
      const title = typeof known === "string" ? known : ""
      const saved = savedTitle(ctx.titles.get(rec.sid))?.title ?? ""
      if (
        !rec.sid.toLowerCase().includes(query) &&
        !rec.cwd.toLowerCase().includes(query) &&
        !rec.model.toLowerCase().includes(query) &&
        !title.toLowerCase().includes(query) &&
        !saved.toLowerCase().includes(query)
      ) {
        return false
      }
    }
    return true
  }
  const candidates = tops.filter((t) => matches(t.rec))
  candidates.sort((a, b) => newestFirst(a.rec, b.rec))

  // Counts (D2): from the index at the start of the call, plus one `stat`
  // for each matching top-level row (a missing file is a stale line; about
  // 45 ms for 17.5k rows on the real store). No file size heuristic for
  // "empty": on the real store most files of 1 KiB or less have a turn.
  // They do not depend on the page, so all pages give the same numbers.
  // A stale summary line (N2) does not count: the row is "unknown".
  const freshSummary = (sid: string): IndexSummaryRecord | undefined => {
    const known = ctx.summaries.get(sid)
    return known && !isStaleSummary(sid, known, ctx) ? known : undefined
  }
  const reasonOf = (t: { rec: IndexRecord; orphan: boolean }): SessionHiddenReason | undefined =>
    indexHiddenReason(t.rec, freshSummary(t.rec.sid)) ?? (t.orphan ? "orphan-child" : undefined)
  const reasons = new Map<string, SessionHiddenReason>()
  const stale = new Set<string>()
  let hiddenCount = 0
  let unknownCount = 0
  let staleCount = 0
  for (const t of candidates) {
    if (!fileExists(t.rec.sid, ctx)) {
      stale.add(t.rec.sid)
      staleCount += 1
      continue
    }
    const reason = reasonOf(t)
    if (reason !== undefined) {
      reasons.set(t.rec.sid, reason)
      hiddenCount += 1
    } else if (freshSummary(t.rec.sid) === undefined) {
      unknownCount += 1
    }
  }

  // Walk to the page (M3). A row takes a position only after it is
  // resolved, also on the pages before `start`, so the page boundaries
  // agree with the shown rows: no row shows on two pages and none is
  // skipped. Cost: the rows with no summary line on pages 0..page are read.
  const start = page * limit
  const rows: SessionCatalogRow[] = []
  let position = 0
  let hiddenChildren = 0
  for (const t of candidates) {
    if (rows.length >= limit) break
    if (stale.has(t.rec.sid)) continue
    const reason = reasons.get(t.rec.sid)
    if (reason !== undefined && !includeHidden) continue
    const row = baseRow(t.rec)
    // Stale index line (the session file is gone): not a row.
    if (!resolveRow(row, ctx)) continue
    let finalReason = reason
    if (finalReason === undefined && row.summary?.turns === 0) {
      finalReason = "empty"
      if (!includeHidden) continue
    }
    if (position < start) {
      position += 1
      continue
    }
    if (finalReason !== undefined) row.hiddenReason = finalReason
    fillForkOf(row, ctx)
    fillTitle(row, ctx)
    hiddenChildren += attachChildren(row, childrenByLead, ctx, includeHidden)
    rows.push(row)
    position += 1
  }

  const visibleOrAll = includeHidden ? candidates.length : candidates.length - hiddenCount
  return {
    rows,
    total: Math.max(0, visibleOrAll - staleCount),
    hiddenCount: hiddenCount + hiddenChildren,
    unknownCount,
  }
}

/**
 * True when the session file of `sid` exists (one `stat`, no read). Keeps
 * its mtime in `ctx.mtimes` for the stale check (N2).
 */
function fileExists(sid: string, ctx: CatalogContext): boolean {
  try {
    const path = sessionFilePath(sid, ctx.dir)
    if (ctx.io.stat) {
      const st = ctx.io.stat(path)
      // NaN: an empty file is never stale (see `isStaleSummary`).
      ctx.mtimes.set(sid, st.size > 0 ? st.mtimeMs : Number.NaN)
    } else ctx.io.size(path)
    return true
  } catch {
    return false
  }
}

/**
 * Attach the sub-agent sessions of `row` (oldest first). Returns the number
 * of empty (0 turns) children that are hidden or marked hidden.
 */
function attachChildren(
  row: SessionCatalogRow,
  childrenByLead: Map<string, IndexRecord[]>,
  ctx: CatalogContext,
  includeHidden: boolean,
  depth = 1,
  visited: Set<string> = new Set([row.sid]),
): number {
  let hidden = 0
  const kids = childrenByLead.get(row.sid) ?? []
  kids.sort(oldestFirst)
  for (const kid of kids) {
    // An orphan (cycle, too deep) is a top-level row (see `leadRoot`).
    if (visited.has(kid.sid) || ctx.orphans.has(kid.sid)) continue
    visited.add(kid.sid)
    const child = baseRow(kid)
    if (!resolveRow(child, ctx)) continue
    if (child.summary?.turns === 0) {
      // An empty child (for example a `ma` run from a worker shell).
      hidden += 1
      if (!includeHidden) continue
      child.hiddenReason = "empty"
    }
    fillForkOf(child, ctx)
    fillTitle(child, ctx)
    // Depth ≥ 2 (M6): a sub-agent of a sub-agent goes under its parent.
    if (depth < MAX_CHILD_DEPTH) {
      hidden += attachChildren(child, childrenByLead, ctx, includeHidden, depth + 1, visited)
    }
    row.children.push(child)
  }
  return hidden
}

/**
 * Follow the `leadSid` chain of the sub-agent `rec` up to a top-level row.
 * Returns `"orphan"` (a top-level row, hidden as `orphan-child`) when the
 * lead of `rec` is not in the index, when the chain has a cycle, or when
 * `rec` is deeper than {@link MAX_CHILD_DEPTH}. Else `"attached"`: `rec`
 * shows under its lead (also when a higher lead is an orphan row).
 */
function leadRoot(rec: IndexRecord, bySid: Map<string, IndexRecord>): "attached" | "orphan" {
  const seen = new Set<string>([rec.sid])
  let cur = rec
  let depth = 0
  for (;;) {
    const leadSid = cur.leadSid
    if (!leadSid || leadSid === cur.sid) return "attached"
    const lead = bySid.get(leadSid)
    if (!lead) return cur === rec ? "orphan" : "attached"
    if (seen.has(leadSid)) return "orphan"
    depth += 1
    if (depth > MAX_CHILD_DEPTH) return "orphan"
    seen.add(leadSid)
    cur = lead
  }
}

/**
 * Lineage backfill: find the lead of old sub-agent sessions (written before
 * the index lines had `leadSid`, `agentId` and `role`) from data that is
 * already saved, and append `kind: "lineage"` lines to the sidecar
 * `index-meta.jsonl` (see `IndexLineageRecord`).
 *
 * Two sources, no guess:
 * - `transcript`: the lead transcript has the spawn tool result
 *   "Spawned sub-agent <id> (<type> · …), running in background as session
 *   <sid>". It gives the link, the agent id and the role.
 * - `ppid`: the first `attach` record of the child has `ppid` equal to the
 *   `pid` of the first `attach` record of exactly one session (same
 *   hostname), and the child attach time is in the live window of that
 *   session (its attach time to its next detach, or to its last record).
 *
 * Cost: one read of the index; the first 4 KiB of each candidate and of each
 * possible lead in the time range; the last 4 KiB of the leads whose pid is
 * a candidate ppid; one streamed scan (64 KiB chunks) of the transcript of
 * each matched or hinted lead (files above 64 MiB are not scanned).
 *
 * @module session-lineage-backfill
 */

import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs"

import { isSafeSessionId } from "./session-id-safety.ts"
import { readParsedSessionIndex } from "./session-index.ts"
import {
  defaultSessionsDir,
  type IndexLineageRecord,
  type IndexLineageSource,
  type IndexRecord,
  indexMetaFilePath,
  sessionFilePath,
} from "./session-store.ts"

/** Options of {@link backfillLineage}. */
export interface BackfillLineageOptions {
  /** Sessions directory. Default `defaultSessionsDir()`. */
  dir?: string
  /** Compute only: write nothing. Default false. */
  dryRun?: boolean
  /** Only candidates created at or after this time (ISO string, `Date` or epoch ms). */
  since?: string | Date | number
  /** Clock for the `at` field (tests). */
  now?: () => Date
}

/** One link found by {@link backfillLineage}. */
export interface BackfillLineageLink {
  sid: string
  leadSid: string
  agentId?: string
  role?: string
  source: IndexLineageSource
}

/** The result of {@link backfillLineage}. */
export interface BackfillLineageResult {
  /** Index rows with no recorded `leadSid` and a sub-agent spawn argv. */
  candidates: number
  /** Links found from a lead transcript. */
  linkedByTranscript: number
  /** Links found from the attach `ppid` only. */
  linkedByPpid: number
  /** Candidates with 2 or more possible leads (skipped). */
  ambiguous: number
  /** Candidates with no possible lead (skipped). */
  unknown: number
  /** Links that the sidecar already has (same sid and lead): not written again. */
  alreadyLinked: number
  /** Lines appended to `index-meta.jsonl` (0 in a dry run). */
  written: number
  /** Number of lead transcripts scanned, and skipped as too large. */
  transcriptsScanned: number
  transcriptsSkipped: number
  /** All links found (also the already linked ones), in candidate order. */
  links: BackfillLineageLink[]
  /** Wall time of the call in ms. */
  elapsedMs: number
}

/** Bytes read at the head (and tail) of a session file. */
export const LINEAGE_HEAD_BYTES = 4096
/** Lead transcripts above this size are not scanned. */
export const LINEAGE_MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024
/** Possible leads are rows created up to this long before the oldest candidate. */
const LEAD_RANGE_MARGIN_MS = 7 * 24 * 60 * 60 * 1000
const CHUNK_BYTES = 64 * 1024
const SPAWN_MARK = "running in background as session "
const SPAWN_RE =
  /Spawned sub-agent ([A-Za-z0-9_.-]{1,32}) \(([A-Za-z][\w-]{0,31})[^)\n]{0,200}\), running in background as session ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g

/** The ppid match of a candidate: one lead sid, or 2+ leads. */
type PpidMatch = { lead: string } | { ambiguous: true }

/** The facts of the head of a session file. */
interface Head {
  parentSid?: string
  attach?: { ts: number; pid: number; ppid: number; hostname: string }
  /** Time of the first detach after the first attach, when in the head. */
  detachTs?: number
}

/** True when the argv has the sub-agent spawn pattern. */
export function isSubagentSpawnArgv(argv: readonly string[] | undefined): boolean {
  if (!argv) return false
  let sid = false
  let prompt = false
  for (const a of argv) {
    if (a === "--session-id" || a.startsWith("--session-id=")) sid = true
    else if (a === "--prompt" || a.startsWith("--prompt=")) prompt = true
  }
  return sid && prompt
}

/** The lead sid from `--startup-profile <dir>/<leadSid>.profile.json`, if any. */
function profileLead(argv: readonly string[] | undefined): string | undefined {
  if (!argv) return undefined
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i] === "--startup-profile" ? argv[i + 1] : undefined
    const m = v ? /([0-9a-f-]{36})\.profile\.json$/.exec(v) : null
    if (m && isSafeSessionId(m[1])) return m[1]
  }
  return undefined
}

/** Read up to `len` bytes of a file at `pos` (negative: from the end). */
function readSlice(path: string, len: number, fromEnd = false): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    const pos = fromEnd ? Math.max(0, size - len) : 0
    const buf = Buffer.alloc(Math.min(len, size))
    const n = readSync(fd, buf, 0, buf.length, pos)
    return buf.subarray(0, n).toString("utf8")
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Parse complete JSON lines of a slice (the cut lines are skipped). */
function sliceRecords(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue
    try {
      const rec = JSON.parse(line) as unknown
      if (typeof rec === "object" && rec !== null) out.push(rec as Record<string, unknown>)
    } catch {
      // A line cut by the slice.
    }
  }
  return out
}

function readHead(dir: string, sid: string): Head | undefined {
  const text = readSlice(sessionFilePath(sid, dir), LINEAGE_HEAD_BYTES)
  if (text === undefined) return undefined
  const head: Head = {}
  for (const rec of sliceRecords(text)) {
    if (rec.kind === "meta" && typeof rec.parentSid === "string") head.parentSid = rec.parentSid
    else if (rec.kind === "attach" && head.attach === undefined) {
      const ts = Date.parse(String(rec.ts))
      if (
        Number.isFinite(ts) &&
        typeof rec.pid === "number" &&
        typeof rec.ppid === "number" &&
        typeof rec.hostname === "string"
      ) {
        head.attach = { ts, pid: rec.pid, ppid: rec.ppid, hostname: rec.hostname }
      }
    } else if (rec.kind === "detach" && head.attach && head.detachTs === undefined) {
      const ts = Date.parse(String(rec.ts))
      if (Number.isFinite(ts)) head.detachTs = ts
    }
  }
  return head
}

/** The time of the last complete record of a session file, or NaN. */
function lastRecordTs(dir: string, sid: string): number {
  const text = readSlice(sessionFilePath(sid, dir), LINEAGE_HEAD_BYTES, true)
  if (text === undefined) return Number.NaN
  const recs = sliceRecords(text)
  for (let i = recs.length - 1; i >= 0; i--) {
    const ts = Date.parse(String(recs[i]?.ts))
    if (Number.isFinite(ts)) return ts
  }
  return Number.NaN
}

/** One spawn claim found in a lead transcript. */
interface Claim {
  leadSid: string
  agentId: string
  role: string
}

/**
 * Scan a lead transcript in chunks for spawn tool results. Returns false when
 * the file is too large or cannot be read.
 */
function scanTranscript(
  dir: string,
  leadSid: string,
  wanted: Set<string>,
  claims: Map<string, Claim[]>,
): boolean {
  let fd: number | undefined
  try {
    fd = openSync(sessionFilePath(leadSid, dir), "r")
    if (fstatSync(fd).size > LINEAGE_MAX_TRANSCRIPT_BYTES) return false
    const buf = Buffer.alloc(CHUNK_BYTES)
    let rest = ""
    const seen = new Set<string>()
    const scanLine = (line: string): void => {
      if (!line.includes(SPAWN_MARK)) return
      for (const m of line.matchAll(SPAWN_RE)) {
        const sid = m[3]
        if (!sid || !wanted.has(sid) || sid === leadSid || seen.has(sid)) continue
        seen.add(sid)
        const list = claims.get(sid) ?? []
        list.push({ leadSid, agentId: m[1] ?? "", role: m[2] ?? "" })
        claims.set(sid, list)
      }
    }
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK_BYTES, null)
      if (n <= 0) break
      const text = rest + buf.subarray(0, n).toString("utf8")
      const lines = text.split("\n")
      rest = lines.pop() ?? ""
      for (const line of lines) scanLine(line)
    }
    scanLine(rest)
    return true
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function sinceMs(since: BackfillLineageOptions["since"]): number | undefined {
  if (since === undefined) return undefined
  const ms =
    since instanceof Date ? since.getTime() : typeof since === "number" ? since : Date.parse(since)
  if (!Number.isFinite(ms))
    throw new RangeError(`backfillLineage: bad since value: ${String(since)}`)
  return ms
}

/**
 * Find the lead of old sub-agent sessions and append `kind: "lineage"` lines
 * to `index-meta.jsonl` (none with `dryRun`). Idempotent: a link that the
 * sidecar already has (same sid and lead) is not written again. A candidate
 * with 0 or 2+ possible leads is skipped.
 *
 * @param opts - See {@link BackfillLineageOptions}.
 */
export function backfillLineage(opts: BackfillLineageOptions = {}): BackfillLineageResult {
  const t0 = performance.now()
  const dir = opts.dir ?? defaultSessionsDir()
  const since = sinceMs(opts.since)
  const parsed = readParsedSessionIndex(dir)

  // One row per sid (the first line wins, like the catalog).
  const bySid = new Map<string, IndexRecord>()
  for (const rec of parsed.sessions) {
    const prev = bySid.get(rec.sid)
    bySid.set(rec.sid, prev ? { ...rec, ...prev } : rec)
  }

  // a. Candidates: no recorded leadSid, sub-agent spawn argv.
  const candidates: IndexRecord[] = []
  for (const rec of bySid.values()) {
    if (rec.leadSid && rec.lineageSource === undefined) continue
    if (!isSubagentSpawnArgv(rec.argv)) continue
    const created = Date.parse(rec.createdAt)
    if (since !== undefined && !(created >= since)) continue
    candidates.push(rec)
  }
  const result: BackfillLineageResult = {
    candidates: candidates.length,
    linkedByTranscript: 0,
    linkedByPpid: 0,
    ambiguous: 0,
    unknown: 0,
    alreadyLinked: 0,
    written: 0,
    transcriptsScanned: 0,
    transcriptsSkipped: 0,
    links: [],
    elapsedMs: 0,
  }
  if (candidates.length === 0) {
    result.elapsedMs = performance.now() - t0
    return result
  }

  // b. Head of each candidate.
  const heads = new Map<string, Head>()
  let minCreated = Number.POSITIVE_INFINITY
  for (const c of candidates) {
    const head = readHead(dir, c.sid)
    if (head) heads.set(c.sid, head)
    const created = Date.parse(c.createdAt)
    if (Number.isFinite(created)) minCreated = Math.min(minCreated, created)
  }
  const ppids = new Set<number>()
  for (const h of heads.values()) if (h.attach) ppids.add(h.attach.ppid)

  // c. Possible leads: first attach of each row in the time range whose pid
  // is a candidate ppid. Key: hostname + pid.
  const lower = minCreated - LEAD_RANGE_MARGIN_MS
  const leadsByKey = new Map<string, { sid: string; from: number; to: number }[]>()
  const leadHeads = new Map<string, Head>()
  for (const rec of bySid.values()) {
    const created = Date.parse(rec.createdAt)
    if (!(created >= lower)) continue
    const head = heads.get(rec.sid) ?? readHead(dir, rec.sid)
    if (!head) continue
    leadHeads.set(rec.sid, head)
    const a = head.attach
    if (!a || !ppids.has(a.pid)) continue
    const to = head.detachTs ?? lastRecordTs(dir, rec.sid)
    const key = `${a.hostname}\u0000${a.pid}`
    const list = leadsByKey.get(key) ?? []
    list.push({ sid: rec.sid, from: a.ts, to: Number.isFinite(to) ? to : a.ts })
    leadsByKey.set(key, list)
  }
  const ppidLead = new Map<string, PpidMatch>()
  for (const c of candidates) {
    const a = heads.get(c.sid)?.attach
    if (!a) continue
    const matches = (leadsByKey.get(`${a.hostname}\u0000${a.ppid}`) ?? []).filter(
      (l) => l.sid !== c.sid && a.ts >= l.from && a.ts <= l.to,
    )
    if (matches.length === 1 && matches[0]) ppidLead.set(c.sid, { lead: matches[0].sid })
    else if (matches.length > 1) ppidLead.set(c.sid, { ambiguous: true })
  }

  // d. Transcript scan of each matched or hinted lead (once each).
  const wanted = new Set(candidates.map((c) => c.sid))
  const toScan = new Set<string>()
  for (const c of candidates) {
    const p = ppidLead.get(c.sid)
    if (p && "lead" in p) toScan.add(p.lead)
    const hint = profileLead(c.argv)
    if (hint && hint !== c.sid && bySid.has(hint)) toScan.add(hint)
  }
  const claims = new Map<string, Claim[]>()
  for (const leadSid of toScan) {
    if (scanTranscript(dir, leadSid, wanted, claims)) result.transcriptsScanned += 1
    else result.transcriptsSkipped += 1
  }

  // Resolve each candidate.
  const at = (opts.now?.() ?? new Date()).toISOString()
  const lines: string[] = []
  for (const c of candidates) {
    const p = ppidLead.get(c.sid)
    const link = resolveLink(c.sid, claims.get(c.sid) ?? [], p, leadHeads)
    if (link === "ambiguous") {
      result.ambiguous += 1
      continue
    }
    if (link === undefined) {
      result.unknown += 1
      continue
    }
    if (link.source === "transcript") result.linkedByTranscript += 1
    else result.linkedByPpid += 1
    result.links.push(link)
    // f. Idempotent: same (sid, leadSid) already in the sidecar.
    if (parsed.lineages.get(c.sid)?.leadSid === link.leadSid) {
      result.alreadyLinked += 1
      continue
    }
    const line: IndexLineageRecord = {
      kind: "lineage",
      v: 1,
      sid: link.sid,
      leadSid: link.leadSid,
      ...(link.agentId ? { agentId: link.agentId } : {}),
      ...(link.role ? { role: link.role } : {}),
      source: link.source,
      at,
    }
    lines.push(JSON.stringify(line))
  }
  if (!opts.dryRun && lines.length > 0) {
    appendFileSync(indexMetaFilePath(dir), `${lines.join("\n")}\n`)
    result.written = lines.length
  }
  result.elapsedMs = performance.now() - t0
  return result
}

/**
 * The link of one candidate. Transcript claims win over the ppid match.
 * Claims from 2+ leads: a fork copies the records of its parent, so a claim
 * of a session whose parent chain has another claimant is dropped; then the
 * ppid lead decides; else ambiguous.
 */
function resolveLink(
  sid: string,
  claims: Claim[],
  ppid: PpidMatch | undefined,
  heads: Map<string, Head>,
): BackfillLineageLink | "ambiguous" | undefined {
  if (claims.length > 0) {
    const leads = new Set(claims.map((c) => c.leadSid))
    let kept = claims.filter((c) => !hasAncestorIn(c.leadSid, leads, heads))
    if (kept.length > 1 && ppid && "lead" in ppid) {
      kept = kept.filter((c) => c.leadSid === ppid.lead)
    }
    if (kept.length === 1 && kept[0]) {
      const c = kept[0]
      return {
        sid,
        leadSid: c.leadSid,
        ...(c.agentId ? { agentId: c.agentId } : {}),
        ...(c.role ? { role: c.role } : {}),
        source: "transcript",
      }
    }
    if (kept.length > 1) return "ambiguous"
  }
  if (ppid && "ambiguous" in ppid) return "ambiguous"
  if (ppid) return { sid, leadSid: ppid.lead, source: "ppid" }
  return undefined
}

/** True when a fork ancestor of `sid` (meta `parentSid` chain) is in `set`. */
function hasAncestorIn(sid: string, set: Set<string>, heads: Map<string, Head>): boolean {
  let cur = heads.get(sid)?.parentSid
  for (let i = 0; cur && i < 16; i++) {
    if (set.has(cur)) return true
    cur = heads.get(cur)?.parentSid
  }
  return false
}

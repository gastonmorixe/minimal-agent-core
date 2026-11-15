/**
 * Retention for the net-dbg capture directory (`<agent-home>/net-dbg/`).
 *
 * Every recording session writes one folder, and nothing ever deleted them
 * (34 GB and 2,313 folders on one dev box, research 2026-11-15). This module
 * prunes the oldest session folders past an age and a total-size budget.
 *
 * Split in two so the policy is testable without a filesystem:
 * {@link planNetDbgPrune} is pure (entries in, victims out);
 * {@link pruneNetDbgDir} reads the directory, applies the plan, and reports.
 *
 * Only folders named like {@link formatSessionDirName} output
 * (`<13-digit epoch>-…-minimal-agent-<sid>`) are candidates. Anything else in
 * the directory is left alone.
 *
 * **Live folders are safe.** Many sessions capture at once, and each process
 * only knows its own folder. So age and ranking use a folder's **last
 * activity** (its newest file's mtime), not the start epoch in its name: a
 * session that started a week ago and wrote a minute ago is young. A folder
 * active within {@link NET_DBG_ACTIVE_GRACE_MS} is never deleted, whatever the
 * budget says. The folder the current process writes to is never deleted
 * either.
 *
 * @module logging/net-dbg-retention
 */

import type { Dirent } from "node:fs"
import { lstat, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

/** Default: keep session folders for 7 days. */
export const DEFAULT_NET_DBG_MAX_AGE_DAYS = 7
/** Default: keep at most 2 GiB of captures in total. */
export const DEFAULT_NET_DBG_MAX_TOTAL_BYTES = 2 * 1024 ** 3
/**
 * A folder written within this window may belong to a running session (this
 * process or a peer), so it is never deleted. Peers cannot see each other's
 * `keep`; this is the cross-process safety net.
 */
export const NET_DBG_ACTIVE_GRACE_MS = 60 * 60_000

/** Retention limits. `0` (or a negative value) turns that limit off. */
export interface NetDbgRetention {
  maxAgeDays: number
  maxTotalBytes: number
}

/**
 * Resolve the user config block (`netDbgRetention`) into limits, filling the
 * defaults. Pure.
 */
export function resolveNetDbgRetention(
  config: { maxAgeDays?: number; maxTotalMB?: number } | undefined,
): NetDbgRetention {
  return {
    maxAgeDays: config?.maxAgeDays ?? DEFAULT_NET_DBG_MAX_AGE_DAYS,
    maxTotalBytes:
      config?.maxTotalMB !== undefined
        ? config.maxTotalMB * 1024 ** 2
        : DEFAULT_NET_DBG_MAX_TOTAL_BYTES,
  }
}

/** One capture session folder, as the planner sees it. */
export interface NetDbgEntry {
  name: string
  /** Start time, epoch ms (the folder name's leading epoch). Tie-break only. */
  startedAt: number
  /** Last write, epoch ms: the newest file mtime inside the folder. */
  lastActivityAt: number
  bytes: number
}

const SESSION_DIR_RE = /^(\d{13})-.*-minimal-agent-[A-Za-z0-9-]+$/

/** The start time encoded in a session folder name, or `undefined` if the name is not one. */
export function sessionDirStartedAt(name: string): number | undefined {
  const m = SESSION_DIR_RE.exec(name)
  return m ? Number(m[1]) : undefined
}

/**
 * Pick the folders to delete. Pure.
 *
 * All by **last activity**: first every folder idle longer than `maxAgeDays`
 * goes; then, least recently active first, folders go until the rest fit in
 * `maxTotalBytes`. Never picked, even when over every limit: `keep` (this
 * process's folder) and any folder active within `graceMs` (maybe a peer's
 * live session). So the size budget is best effort while sessions run.
 *
 * @returns Names to delete, least recently active first.
 */
export function planNetDbgPrune(
  entries: readonly NetDbgEntry[],
  retention: NetDbgRetention,
  now: number,
  keep?: string,
  graceMs: number = NET_DBG_ACTIVE_GRACE_MS,
): string[] {
  const sorted = [...entries].sort(
    (a, b) => a.lastActivityAt - b.lastActivityAt || a.startedAt - b.startedAt,
  )
  const protectedName = (e: NetDbgEntry): boolean =>
    e.name === keep || e.lastActivityAt > now - graceMs
  const victims = new Set<string>()
  if (retention.maxAgeDays > 0) {
    const cutoff = now - retention.maxAgeDays * 86_400_000
    for (const e of sorted) {
      if (e.lastActivityAt < cutoff && !protectedName(e)) victims.add(e.name)
    }
  }
  if (retention.maxTotalBytes > 0) {
    let total = sorted.reduce((n, e) => (victims.has(e.name) ? n : n + e.bytes), 0)
    for (const e of sorted) {
      if (total <= retention.maxTotalBytes) break
      if (victims.has(e.name) || protectedName(e)) continue
      victims.add(e.name)
      total -= e.bytes
    }
  }
  return sorted.filter((e) => victims.has(e.name)).map((e) => e.name)
}

/** What {@link pruneNetDbgDir} did. */
export interface NetDbgPruneResult {
  removed: number
  freedBytes: number
  keptBytes: number
}

/**
 * Total size and newest mtime of the regular files under `path` (no symlink
 * following). The folder's own mtime is not used: appending to a file inside
 * it does not change it, and that is exactly how a live capture writes.
 */
async function dirStats(path: string): Promise<{ bytes: number; lastActivityAt: number }> {
  let bytes = 0
  let lastActivityAt = (await lstat(path)).mtimeMs
  for (const d of await readdir(path, { withFileTypes: true })) {
    const p = join(path, d.name)
    if (d.isDirectory()) {
      const sub = await dirStats(p)
      bytes += sub.bytes
      lastActivityAt = Math.max(lastActivityAt, sub.lastActivityAt)
    } else if (d.isFile()) {
      const st = await lstat(p)
      bytes += st.size
      lastActivityAt = Math.max(lastActivityAt, st.mtimeMs)
    }
  }
  return { bytes, lastActivityAt }
}

/**
 * Overrides for {@link pruneNetDbgDir}; the defaults come from
 * {@link NET_DBG_ACTIVE_GRACE_MS} and the wall clock.
 */
type PruneNetDbgDirOpts = {
  /** A folder name the prune must never delete. */
  keep?: string
  /** Clock used for the age cutoff, in epoch ms. Defaults to `Date.now()`. */
  now?: number
  /** Recent-activity window that is never deleted, in ms. */
  graceMs?: number
}

/**
 * Apply retention to `root`. Async, so a large capture directory never
 * blocks the event loop. A missing directory is a no-op. A folder that
 * fails to read or delete is skipped, so one bad entry never stops the rest.
 *
 * @param root - The net-dbg base directory.
 * @param retention - The limits.
 * @param opts - Folder to keep, clock, and grace-window overrides (tests).
 */
export async function pruneNetDbgDir(
  root: string,
  retention: NetDbgRetention,
  opts: PruneNetDbgDirOpts = {},
): Promise<NetDbgPruneResult> {
  const result: NetDbgPruneResult = { removed: 0, freedBytes: 0, keptBytes: 0 }
  if (retention.maxAgeDays <= 0 && retention.maxTotalBytes <= 0) return result
  let dirents: Dirent[]
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch {
    return result
  }
  const entries: NetDbgEntry[] = []
  for (const d of dirents) {
    const startedAt = sessionDirStartedAt(d.name)
    if (startedAt === undefined || !d.isDirectory()) continue
    try {
      entries.push({ name: d.name, startedAt, ...(await dirStats(join(root, d.name))) })
    } catch {
      // unreadable entry: leave it alone
    }
  }
  const victims = new Set(
    planNetDbgPrune(entries, retention, opts.now ?? Date.now(), opts.keep, opts.graceMs),
  )
  for (const e of entries) {
    if (!victims.has(e.name)) {
      result.keptBytes += e.bytes
      continue
    }
    try {
      await rm(join(root, e.name), { recursive: true, force: true })
      result.removed++
      result.freedBytes += e.bytes
    } catch {
      result.keptBytes += e.bytes
    }
  }
  return result
}

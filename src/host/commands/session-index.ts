import { existsSync, readFileSync } from "node:fs"

import { type IndexRecord, indexFilePath, sessionFilePath } from "../../session/session-store.ts"

/**
 * Read the global sessions index. Returns one record per saved session,
 * in append order (oldest first). Missing index file → empty array.
 *
 * Defensive filter: entries whose backing `<sid>.jsonl` no longer exists
 * on disk are dropped. The graceful-exit path in `src/index.ts` keeps
 * the index and the JSONL log in sync (cleanup of empty sessions
 * rewrites the index), but a SIGKILL or manual `rm` can leave a stale
 * row behind. Returning dead sids here would mean `--sessions` lists
 * phantoms and `--resume last` resolves to a missing file. This filter
 * is one `existsSync` per entry, cheap and read-only.
 */
export function readSessionIndex(): IndexRecord[] {
  const path = indexFilePath()
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch {
    return []
  }
  const out: IndexRecord[] = []
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    try {
      const rec = JSON.parse(line) as IndexRecord
      if (!existsSync(sessionFilePath(rec.sid))) continue
      out.push(rec)
    } catch {
      // Skip malformed lines silently — index is best-effort metadata.
    }
  }
  return out
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
 * - A short prefix (e.g. `"260d72dd"`) — resolved against the session index
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

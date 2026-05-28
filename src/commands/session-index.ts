import { existsSync, readFileSync } from "node:fs"

import { type IndexRecord, indexFilePath, sessionFilePath } from "../session-store.ts"

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
 * Resolve `<sid|last>` to a concrete sid.
 *
 * For `last`, prefer the most recent session whose `cwd` matches the current
 * process cwd; fall back to the global most recent.
 */
export function resolveSessionTarget(target: string, cwd: string): string | null {
  if (target !== "last") return target
  const all = readSessionIndex()
  if (all.length === 0) return null
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].cwd === cwd) return all[i].sid
  }
  return all[all.length - 1].sid
}

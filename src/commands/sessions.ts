import { readFileSync, statSync } from "node:fs"

import { firstUserPromptSnippet } from "../session-restore.ts"
import {
  defaultSessionsDir,
  type IndexRecord,
  parseLines as parseSessionLines,
  sessionFilePath,
} from "../session-store.ts"
import { computeSessionUsage, type SessionUsage, ZERO_SESSION_USAGE } from "../session-usage.ts"
import { renderSessionsCommandRows, type SessionCommandRow } from "../ui/chrome/sessions-command.ts"
import { type CommandOutput, writeCommandRows } from "../ui/command-output.ts"

import { readSessionIndex } from "./session-index.ts"

/**
 * Fuzzy subsequence match (case-insensitive). Returns true if every
 * character of `needle` appears, in order, somewhere in `haystack`.
 * `"abc"` matches `"a-bigger-c"`. Empty needle matches anything.
 *
 * Cheap: O(|haystack|), no allocation beyond the lowercased copies.
 * Good enough for the index-only filter — anything fancier (rank by
 * proximity, score gaps, etc.) is a separate problem.
 */
export function fuzzyMatch(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true
  const n = needle.toLowerCase()
  const h = haystack.toLowerCase()
  let i = 0
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) i++
  }
  return i === n.length
}

/**
 * Filter predicate for `sessions <query>`. Searches the three cheap
 * index fields ONLY: createdAt (session date), sid (session id),
 * and cwd (session workdir). Per-session file reads happen later —
 * the whole point of in-index filtering is to skip them for
 * non-matches. See {@link runSessionsCommand}.
 *
 * Matches per-field (OR), not against a joined haystack. Joining was
 * too lenient: a query like `2026-05-27` was finding a subsequence
 * across `createdAt`'s tail → sid → cwd, returning unrelated dates.
 * A useful fuzzy filter has to honor field boundaries.
 */
export function matchesQuery(rec: IndexRecord, query: string): boolean {
  if (query.length === 0) return true
  return (
    fuzzyMatch(query, rec.createdAt) ||
    fuzzyMatch(query, rec.sid) ||
    fuzzyMatch(query, rec.cwd ?? "")
  )
}

export interface RunSessionsOptions {
  /** Optional fuzzy filter applied to date+sid+cwd before any file I/O. */
  query?: string
  /** Output stream; tests inject a collector. */
  output?: CommandOutput
}

/**
 * `--sessions [<query>]`: print a table of saved sessions and exit.
 *
 * When `query` is set, filter happens BEFORE per-session file reads so
 * we don't pay for snippet extraction or size stats on rows the user
 * won't see. The cheap-first ordering is the reason this lives in the
 * agent rather than as a downstream `| grep` pipe.
 */
export function runSessionsCommand(opts: RunSessionsOptions = {}): void {
  const query = opts.query?.trim() ?? ""
  const all = readSessionIndex()
  const sessionsDir = defaultSessionsDir()
  if (all.length === 0) {
    writeCommandRows(
      renderSessionsCommandRows({ allCount: 0, rows: [], query, sessionsDir }),
      opts.output,
    )
    return
  }
  // Index-only filter pass. Pure in-memory string match on three small
  // fields per record. No file reads.
  const matched = query.length > 0 ? all.filter((rec) => matchesQuery(rec, query)) : all
  if (matched.length === 0) {
    writeCommandRows(
      renderSessionsCommandRows({ allCount: all.length, rows: [], query, sessionsDir }),
      opts.output,
    )
    return
  }
  const rows: SessionCommandRow[] = []
  for (const rec of matched) {
    const path = sessionFilePath(rec.sid)
    let bytes = Number.NaN
    let snippet = ""
    let usage: SessionUsage = { ...ZERO_SESSION_USAGE }
    try {
      // Cheap stat first (no read). Lets us still show the size even
      // if the snippet read fails for some reason.
      bytes = statSync(path).size
    } catch {
      // File vanished between readSessionIndex's existsSync and now —
      // rare race. Leave size as NaN, formatBytes renders "—".
    }
    try {
      // Read the whole file — they're append-only JSONL, typically small.
      // For huge sessions this is still fine because we only do it on
      // matched rows of an explicit `--sessions` listing (one-shot),
      // not in any hot path. One parse feeds both the snippet AND the
      // token-usage aggregation (real-from-saved-usage or estimated).
      const text = readFileSync(path, "utf-8")
      const { records: parsed } = parseSessionLines(text)
      snippet = firstUserPromptSnippet(parsed, 40)
      usage = computeSessionUsage(parsed, { modelId: rec.model })
    } catch {
      // ignore — session file may have been deleted
    }
    rows.push({
      createdAt: rec.createdAt,
      sid: rec.sid,
      model: rec.model,
      bytes,
      usage,
      cwd: rec.cwd,
      snippet,
    })
  }
  writeCommandRows(
    renderSessionsCommandRows({ allCount: all.length, rows, query, sessionsDir }),
    opts.output,
  )
}

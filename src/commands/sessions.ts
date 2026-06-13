import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"

import { firstUserPromptSnippet } from "../session-restore.ts"
import {
  defaultSessionsDir,
  type IndexRecord,
  parseLines as parseSessionLines,
  sessionFilePath,
} from "../session-store.ts"
import { computeSessionUsage, type SessionUsage, ZERO_SESSION_USAGE } from "../session-usage.ts"
import { type CommandOutput, writeCommandRows } from "../ui/command-output.ts"
import { c } from "../ui/style/ansi.ts"

import { readSessionIndex } from "./session-index.ts"

const PATH_COL_WIDTH = 30
const SIZE_COL_WIDTH = 9
/**
 * Width of the tokens column: a compact count (`232.4k`) plus a trailing
 * `[R]`/`[E]` provenance marker. Wide enough for `1.2M [E]`.
 */
const TOKENS_COL_WIDTH = 11

/**
 * Collapse `$HOME` to `~` and left-truncate (with `…`) so the tail of the
 * path — usually the most identifying part — stays visible.
 */
function formatCwd(cwd: string, width: number): string {
  const home = homedir()
  let p = cwd
  if (home && (p === home || p.startsWith(`${home}/`))) {
    p = `~${p.slice(home.length)}`
  }
  if (p.length > width) p = `…${p.slice(p.length - width + 1)}`
  return p.padEnd(width)
}

/**
 * Format a byte count as a compact, right-aligned label fitting
 * {@link SIZE_COL_WIDTH}. Examples: `   312 B`, ` 487.4 kB`, `   2.3 MB`.
 *
 * Decimal kB/MB (1000-based) would be slightly more user-friendly for
 * tiny files, but the rest of the codebase (e.g. `src/status.ts`) uses
 * binary (1024-based). Stay consistent.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—".padStart(SIZE_COL_WIDTH)
  if (n < 1024) return `${n} B`.padStart(SIZE_COL_WIDTH)
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`.padStart(SIZE_COL_WIDTH)
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`.padStart(SIZE_COL_WIDTH)
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`.padStart(SIZE_COL_WIDTH)
}

/**
 * Compact token count: `0`, `847`, `12.3k`, `1.2M`. Drops a trailing `.0`
 * so round thousands read `12k`, not `12.0k`. Mirrors the `fmtTokens`
 * formatter in the quota-status footer so the two surfaces agree.
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return String(n)
}

/**
 * Render the tokens column cell: a right-aligned compact count plus a
 * provenance marker — `[R]` (real, summed from saved billed usage) or
 * `[E]` (estimated from transcript text). A session with no assistant
 * turns shows a dim em-dash. Padded to {@link TOKENS_COL_WIDTH}.
 */
export function formatTokenCell(usage: SessionUsage): string {
  if (usage.turns === 0) return "—".padStart(TOKENS_COL_WIDTH)
  const marker = usage.estimated ? "[E]" : "[R]"
  return `${formatTokenCount(usage.tokens)} ${marker}`.padStart(TOKENS_COL_WIDTH)
}

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

export interface SessionCommandRow {
  createdAt: string
  sid: string
  model: string
  bytes: number
  usage: SessionUsage
  cwd?: string
  snippet: string
}

export interface SessionsRenderInput {
  allCount: number
  rows: readonly SessionCommandRow[]
  query?: string
}

function formatSessionTableRow(row: SessionCommandRow): string {
  const when = c.dim(row.createdAt.replace("T", " ").slice(0, 19))
  const sid = c.cyan(row.sid.padEnd(38))
  const model = c.dim(row.model.padEnd(22))
  const size = c.dim(formatBytes(row.bytes))
  // Estimated counts read dim (less trustworthy); real counts read in a
  // brighter faint-white so the [R] rows stand out at a glance.
  const tokens =
    row.usage.turns === 0
      ? c.dim(formatTokenCell(row.usage))
      : row.usage.estimated
        ? c.dim(formatTokenCell(row.usage))
        : c.faintWhite(formatTokenCell(row.usage))
  const cwd = c.dim(formatCwd(row.cwd ?? "", PATH_COL_WIDTH))
  return `  ${when}  ${sid} ${model} ${size} ${tokens} ${cwd} ${c.faintWhite(row.snippet)}`
}

/** Render the `sessions` command table/empty states without writing to the terminal. */
export function renderSessionsCommandRows(input: SessionsRenderInput): string[] {
  const query = input.query?.trim() ?? ""
  if (input.allCount === 0) {
    return [
      "",
      `  ${c.dim("no saved sessions yet")}`,
      `  ${c.dim(`(sessions are stored at ${defaultSessionsDir()})`)}`,
    ]
  }
  if (input.rows.length === 0) {
    return [
      "",
      `  ${c.dim(`no sessions matching ${JSON.stringify(query)}`)}`,
      `  ${c.dim(`(${input.allCount} total at ${defaultSessionsDir()})`)}`,
    ]
  }

  const rendered = [
    "",
    `  ${c.bold("when".padEnd(20))} ${c.bold("sid".padEnd(38))} ${c.bold("model".padEnd(22))} ${c.bold("size".padStart(SIZE_COL_WIDTH))} ${c.bold("tokens".padStart(TOKENS_COL_WIDTH))} ${c.bold("cwd".padEnd(PATH_COL_WIDTH))} ${c.bold("preview")}`,
    ...input.rows.map(formatSessionTableRow),
    "",
  ]
  const summary =
    query.length > 0
      ? `${input.rows.length} of ${input.allCount} session(s) matching ${JSON.stringify(query)}`
      : `${input.allCount} session(s) at ${defaultSessionsDir()}`
  rendered.push(`  ${c.dim(summary)}`)
  rendered.push(`  ${c.dim("resume with: --resume <sid>  (or --resume last)")}`)
  return rendered
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
  if (all.length === 0) {
    writeCommandRows(renderSessionsCommandRows({ allCount: 0, rows: [], query }), opts.output)
    return
  }
  // Index-only filter pass. Pure in-memory string match on three small
  // fields per record. No file reads.
  const matched = query.length > 0 ? all.filter((rec) => matchesQuery(rec, query)) : all
  if (matched.length === 0) {
    writeCommandRows(
      renderSessionsCommandRows({ allCount: all.length, rows: [], query }),
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
  writeCommandRows(renderSessionsCommandRows({ allCount: all.length, rows, query }), opts.output)
}

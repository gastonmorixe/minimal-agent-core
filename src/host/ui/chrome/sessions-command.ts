/**
 * Host-owned `sessions` command table chrome.
 *
 * The command layer reads session indexes/files; this module owns the terminal
 * table, empty states, and compact size/token/path formatting.
 *
 * @module ui/chrome/sessions-command
 */

import { homedir } from "node:os"

import type { SessionUsage } from "../../../session-usage.ts"
import { c } from "../style/ansi.ts"

const PATH_COL_WIDTH = 30
const SIZE_COL_WIDTH = 9
/**
 * Width of the tokens column: a compact count (`232.4k`) plus a trailing
 * `[R]`/`[E]` provenance marker. Wide enough for `1.2M [E]`.
 */
const TOKENS_COL_WIDTH = 11

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
  sessionsDir: string
  query?: string
}

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
 * Format a byte count as a compact, right-aligned label fitting the size column.
 * Examples: `   312 B`, ` 487.4 kB`, `   2.3 MB`.
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
 * so round thousands read `12k`, not `12.0k`.
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
 * turns shows a dim em-dash.
 */
export function formatTokenCell(usage: SessionUsage): string {
  if (usage.turns === 0) return "—".padStart(TOKENS_COL_WIDTH)
  const marker = usage.estimated ? "[E]" : "[R]"
  return `${formatTokenCount(usage.tokens)} ${marker}`.padStart(TOKENS_COL_WIDTH)
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
      `  ${c.dim(`(sessions are stored at ${input.sessionsDir})`)}`,
    ]
  }
  if (input.rows.length === 0) {
    return [
      "",
      `  ${c.dim(`no sessions matching ${JSON.stringify(query)}`)}`,
      `  ${c.dim(`(${input.allCount} total at ${input.sessionsDir})`)}`,
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
      : `${input.allCount} session(s) at ${input.sessionsDir}`
  rendered.push(`  ${c.dim(summary)}`)
  rendered.push(`  ${c.dim("resume with: --resume <sid>  (or --resume last)")}`)
  return rendered
}

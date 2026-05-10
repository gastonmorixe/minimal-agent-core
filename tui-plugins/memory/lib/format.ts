/**
 * Render bullets and tool results to text / ANSI for the `MemoryTool`
 * handler and the CLI.
 *
 * Two surfaces, same content:
 *   - `text`  — compact, no color, suitable for `tool_result.content`
 *               (sent to the model) and for `--json` / piped CLI output.
 *   - `ansi`  — same layout with terminal color, returned in
 *               `tool_result.display` and printed by the CLI directly
 *               to a TTY.
 *
 * No internal-package imports — formatter stays usable from the CLI and
 * any future test harness.
 *
 * @module memory/lib/format
 */

import type { Bullet } from "./parse.ts"

// Raw ANSI — keep this module dep-free / palette-agnostic.
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const FG_CYAN = "\x1b[36m"
const FG_GREEN = "\x1b[32m"
const FG_RED = "\x1b[31m"
const FG_YELLOW = "\x1b[33m"
const RESET = "\x1b[0m"

const BODY_MAX = 240

/**
 * Strip the timezone offset from an ISO timestamp and replace `T` with a
 * space, for compact display: `2026-05-08T16:57:30-04:00` → `2026-05-08 16:57:30`.
 * Returns `(no ts)` for null. Dropping the offset is fine for display
 * since the user is typically reading in their local zone anyway.
 */
function formatTs(ts: string | null): string {
  if (ts === null) return "(no ts)"
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(ts)
  if (!m) return ts
  return `${m[1]} ${m[2]}`
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface FormatListOptions {
  scope: string
  ansi: boolean
  /** Optional pre-truncate of bodies for visual compactness. Default 240. */
  bodyMax?: number
  /** Optional total count when results were sliced (for "showing N of M"). */
  total?: number
}

/**
 * Render a `list` result. One header line + one line per bullet:
 *
 *   project (3 entries):
 *     #abc-1234   2026-05-08 16:57   hello world
 *     #def-5678   (no ts)            another bullet
 *
 * When `total` is set and differs from `bullets.length`, header reads
 * `project (showing 5 of 12 entries)`.
 *
 * Always emits a trailing newline so callers can `.write()` the output
 * directly without ad-hoc spacing.
 */
export function formatList(
  bullets: readonly Bullet[],
  opts: FormatListOptions,
): string {
  const max = opts.bodyMax ?? BODY_MAX
  const lines: string[] = []
  const total = opts.total ?? bullets.length
  const cnt = bullets.length

  // Header
  let header: string
  if (cnt === 0) header = `${opts.scope} (no entries)`
  else if (total !== cnt) header = `${opts.scope} (showing ${cnt} of ${total} entries)`
  else if (cnt === 1) header = `${opts.scope} (1 entry)`
  else header = `${opts.scope} (${cnt} entries)`
  lines.push(opts.ansi ? `${BOLD}${header}${RESET}` : header)

  // ID width for column alignment — pad to longest id (with `#` prefix),
  // capped so legacy ids don't blow out the table on small terminals.
  const idWidth = Math.min(
    24,
    bullets.reduce((m, b) => Math.max(m, b.id.length + 1), 0),
  )
  // TS column width is fixed (`YYYY-MM-DD HH:MM:SS` = 19 chars, or `(no ts)`).
  const tsWidth = 19

  for (const b of bullets) {
    const id = `#${b.id}`.padEnd(idWidth)
    const ts = formatTs(b.ts).padEnd(tsWidth)
    const body = clip(b.body, max)
    if (opts.ansi) {
      lines.push(`  ${FG_CYAN}${id}${RESET}  ${DIM}${ts}${RESET}  ${body}`)
    } else {
      lines.push(`  ${id}  ${ts}  ${body}`)
    }
  }
  return `${lines.join("\n")}\n`
}

// ---------------------------------------------------------------------------
// read (single bullet)
// ---------------------------------------------------------------------------

export function formatRead(b: Bullet, scope: string, ansi: boolean): string {
  const id = `#${b.id}`
  const ts = formatTs(b.ts)
  const sid = b.sid ? `[session:${b.sid}] ` : ""
  if (ansi) {
    return `${BOLD}${scope}${RESET} ${FG_CYAN}${id}${RESET}  ${DIM}${ts}${RESET}\n${DIM}${sid}${RESET}${b.body}\n`
  }
  return `${scope} ${id}  ${ts}\n${sid}${b.body}\n`
}

// ---------------------------------------------------------------------------
// add / edit / remove confirmations
// ---------------------------------------------------------------------------

export function formatAdded(b: Bullet, scope: string, evicted: number, ansi: boolean): string {
  const tag = `[${scope}#${b.id}]`
  const evictedHint = evicted > 0 ? ` (evicted ${evicted} oldest)` : ""
  const body = clip(b.body, BODY_MAX)
  if (ansi) {
    return `${FG_GREEN}saved${RESET} ${BOLD}${tag}${RESET}${evicted > 0 ? `${FG_YELLOW}${evictedHint}${RESET}` : ""}: ${body}\n`
  }
  return `saved ${tag}${evictedHint}: ${body}\n`
}

export function formatEdited(b: Bullet, scope: string, ansi: boolean): string {
  const tag = `[${scope}#${b.id}]`
  const body = clip(b.body, BODY_MAX)
  if (ansi) {
    return `${FG_GREEN}edited${RESET} ${BOLD}${tag}${RESET}: ${body}\n`
  }
  return `edited ${tag}: ${body}\n`
}

export function formatRemoved(b: Bullet, scope: string, ansi: boolean): string {
  const tag = `[${scope}#${b.id}]`
  const body = clip(b.body, BODY_MAX)
  if (ansi) {
    return `${FG_RED}removed${RESET} ${BOLD}${tag}${RESET}: ${DIM}${body}${RESET}\n`
  }
  return `removed ${tag}: ${body}\n`
}

export function formatCleared(count: number, scope: string, ansi: boolean): string {
  if (ansi) {
    return `${FG_RED}cleared${RESET} ${BOLD}${count}${RESET} ${scope} entries\n`
  }
  return `cleared ${count} ${scope} entries\n`
}

// ---------------------------------------------------------------------------
// JSON shape (for tool `format=json` and CLI `--json`)
// ---------------------------------------------------------------------------

export interface BulletJson {
  id: string
  ts: string | null
  sid: string | null
  body: string
  is_legacy: boolean
}

export function bulletToJson(b: Bullet): BulletJson {
  return {
    id: b.id,
    ts: b.ts,
    sid: b.sid,
    body: b.body,
    is_legacy: b.isLegacy,
  }
}

export function bulletsToJson(bs: readonly Bullet[]): BulletJson[] {
  return bs.map(bulletToJson)
}

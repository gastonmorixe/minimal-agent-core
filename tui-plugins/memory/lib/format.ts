/**
 * Render bullets and tool results to text / ANSI for the `MemoryTool`
 * handler and the CLI.
 *
 * Two surfaces, same content:
 *   - `text` : compact, no color, suitable for `tool_result.content`
 *               (sent to the model) and for `--json` / piped CLI output.
 *   - `ansi` : same layout with terminal color, returned in
 *               `tool_result.display` and printed by the CLI directly
 *               to a TTY.
 *
 * No internal-package imports: formatter stays usable from the CLI and
 * any future test harness.
 *
 * @module memory/lib/format
 */

import type { Bullet } from "./parse.ts"

// Raw ANSI: keep this module dep-free / palette-agnostic.
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const FG_CYAN = "\x1b[36m"
const FG_GREEN = "\x1b[32m"
const FG_RED = "\x1b[31m"
const FG_YELLOW = "\x1b[33m"
const RESET = "\x1b[0m"

/**
 * Default body clip for single-bullet display (read / add / edit /
 * remove confirmations). Long-form: room to recognize the bullet
 * without flooding the transcript.
 */
const BODY_MAX = 240

/**
 * Default body clip for entries inside a `list` result. Shorter than
 * {@link BODY_MAX} because list results show many bullets at once and
 * compress poorly otherwise. The full body is always available via
 * `MemoryTool({action: "read", id})`.
 */
export const LIST_PREVIEW_MAX = 160

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
  /**
   * Optional per-bullet body clip. Defaults to {@link LIST_PREVIEW_MAX}
   * so list results stay compact. Full bodies are recovered via `read`.
   */
  bodyMax?: number
  /**
   * Total count of matches (before pagination). When omitted, defaults
   * to `bullets.length`. Used to render the "showing X of Y" header.
   */
  total?: number
  /**
   * Offset of this page from the most-recent end (0 = newest entries).
   * Surfaces in the header so the caller knows where in the stream they
   * are. Defaults to 0 (un-paginated).
   */
  offset?: number
  /**
   * Effective `limit` used to compute this page. Surfaces in the next-
   * page hint so the model can compute the next call site. Omitting
   * suppresses the hint regardless of {@link nextOffset}.
   */
  limit?: number
  /**
   * Offset for the next page, or `null` if this is the last page.
   * When set (and `limit` is set), the header includes a
   * `next: offset=N` hint.
   */
  nextOffset?: number | null
  /**
   * Optional substring filter applied upstream. Surfaces in the header
   * as `matches for "X"` so the model sees what filter is in effect.
   */
  query?: string
}

/**
 * Render a `list` result. One header line + one line per bullet:
 *
 *   project (3 entries):
 *     #abc-1234   2026-05-08 16:57   hello world
 *     #def-5678   (no ts)            another bullet
 *
 * Pagination-aware: when `bullets.length < total`, the header includes
 * `showing N of M, offset=O` and, when there's a next page, an explicit
 * `MemoryTool({offset: K})` hint so the model has the exact next call.
 *
 * Always emits a trailing newline so callers can `.write()` the output
 * directly without ad-hoc spacing.
 */
export function formatList(
  bullets: readonly Bullet[],
  opts: FormatListOptions,
): string {
  const max = opts.bodyMax ?? LIST_PREVIEW_MAX
  const total = opts.total ?? bullets.length
  const cnt = bullets.length

  const headerText = buildListHeader({
    scope: opts.scope,
    shown: cnt,
    total,
    offset: opts.offset,
    limit: opts.limit,
    nextOffset: opts.nextOffset,
    query: opts.query,
  })

  const lines: string[] = []
  lines.push(opts.ansi ? `${BOLD}${headerText}${RESET}` : headerText)

  // ID width for column alignment: pad to longest id (with `#` prefix),
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

  // Trailing hint line for paginated results, on its own row so it
  // survives a quick scan. Skip for un-paginated lists.
  const hint = buildNextPageHint({
    scope: opts.scope,
    nextOffset: opts.nextOffset,
    limit: opts.limit,
    query: opts.query,
  })
  if (hint) {
    lines.push(opts.ansi ? `  ${DIM}${hint}${RESET}` : `  ${hint}`)
  }

  return `${lines.join("\n")}\n`
}

interface BuildHeaderArgs {
  scope: string
  shown: number
  total: number
  offset?: number
  limit?: number
  nextOffset?: number | null
  query?: string
}

/**
 * Compose the human-readable header line for a list result. Kept pure
 * (no I/O, no ANSI) so it's trivially testable and re-usable.
 *
 * Header shapes (no ANSI shown):
 *
 *   project (no entries)
 *   project (no entries matching "wrap")
 *   project (1 entry)
 *   project (3 entries)
 *   project (showing 20 of 122 entries, offset 0)
 *   project (showing 22 of 122 entries, offset 100)        : last page
 *   project (showing 5 of 12 entries matching "compositor"): query, single page
 *
 * "Newest first" semantics: offset=0 always means "the most recent
 * page". The model reasons in pages of size `limit`, walking back into
 * the history as offset grows.
 */
export function buildListHeader(args: BuildHeaderArgs): string {
  const { scope, shown, total, offset = 0, query } = args
  const matchSuffix = query ? ` matching "${query}"` : ""

  if (total === 0) return `${scope} (no entries${matchSuffix})`

  // Un-paginated (or single-page-fits-all) case.
  if (shown === total) {
    const noun = total === 1 ? "entry" : "entries"
    return `${scope} (${total} ${noun}${matchSuffix})`
  }

  // Paginated case: header always anchors at "showing X of Y entries".
  return `${scope} (showing ${shown} of ${total} entries${matchSuffix}, offset ${offset})`
}

interface BuildHintArgs {
  scope: string
  nextOffset?: number | null
  limit?: number
  query?: string
}

/**
 * Build the next-page hint line, or `""` when no hint applies.
 *
 * Emitted only when (a) the caller passed a non-null `nextOffset` AND
 * (b) `limit` is also set. The hint reads as a concrete tool call so
 * the model can paste it back verbatim:
 *
 *   next: MemoryTool({action: "list", scope: "project", offset: 20, limit: 20})
 */
export function buildNextPageHint(args: BuildHintArgs): string {
  if (args.nextOffset == null || args.limit == null) return ""
  const parts = [
    `action: "list"`,
    `scope: "${args.scope}"`,
    `offset: ${args.nextOffset}`,
    `limit: ${args.limit}`,
  ]
  if (args.query) parts.push(`query: ${JSON.stringify(args.query)}`)
  return `next: MemoryTool({${parts.join(", ")}})`
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

/**
 * Pure builder for the queued-message decoration block surfaced above
 * the editor prompt while an agent turn is in flight.
 *
 * Layout (n = queue.length):
 *
 * ```text
 *   ⏳ queued · n             <- header: count as trailing badge
 *   ┊  1 ▸ first preview      <- item rows: position + ▸ + preview
 *   ┊  2 ▸ second preview
 *   ╰  3 ▸ third preview      <- last visible row uses ╰
 * ```
 *
 * Overflow (n exceeds QUEUE_MAX_VISIBLE_ITEMS):
 *
 * ```text
 *   ⏳ queued · n
 *   ┊  1 ▸ first
 *   …  (rows 2..10) …
 *   ╰  ... and (n-10) more    <- elision tail closes the block
 * ```
 *
 * Item numbering is 1-based; per-row layout pads the 1-cell `┊` / `╰`
 * glyph with one extra space so its number column aligns under the
 * wide-emoji `⏳` (2 cells) in the header. The header count is placed
 * as a trailing `· n` badge so its digit does NOT share a column with
 * the item ordinals below — the previous "n queued" form put the count
 * digit and the item digits in the same column, reading as a confusing
 * vertical strip (e.g. "2 / 1 / 2" for a two-item queue).
 *
 * Each preview is whitespace-collapsed and display-width-truncated to
 * QUEUE_PREVIEW_W cells, with a `(+Nch)` hint when cut.
 *
 * Returns [] when queue is empty. Pure: no I/O, no closure state.
 * Callers paint the result via `editor.setDecorationLines(...)`.
 *
 * Lifted out of `runReplLiveArea` in agent.ts (May 2026) so unit tests
 * can assert exact bytes — see queue-decoration.test.ts. Closes the
 * "Bug 4: zero coverage for renderDecoration" entry in
 * work/TODO-queue-bugs.md.
 *
 * Selection / navigation mode (June 2026)
 * ---------------------------------------
 * When the user presses ↑ at an empty prompt with more than one queued item, the
 * REPL enters a transient "queue navigation" mode: one row is selected
 * (highlighted with a full-width background bar) and a footer hint row
 * teaches the d / x / k / esc actions. Pass `opts.selectedIndex` to
 * render that state; pass `opts.cols` so the highlight bar spans the
 * full terminal width. With `selectedIndex == null` (the default) the
 * builder renders the plain, non-interactive block exactly as before
 * (byte-for-byte) so a turn that merely has a queue looks unchanged.
 */
import { ANSI_CODES, bgRgb, ansiStyle as c } from "@minimal-agent/plugin-api/utils/ansi"

import { displayWidth, truncateDisplayWidth } from "../../../term-width.ts"
import { truncHint } from "../../../truncate-hint.ts"

/**
 * Cap on item rows before eliding into a "... and N more" tail. Bumped
 * from 3 → 10 (Bug 19283): deep queues stay readable inline without
 * forcing the user to wait for a tool-boundary drain to see what they
 * typed three submits ago. With cap=10 the worst-case decoration block
 * is 12 rows tall (header + 10 items + elision tail) — fits comfortably
 * in any terminal taller than ~20 rows alongside the prompt.
 */
export const QUEUE_MAX_VISIBLE_ITEMS = 10

/** Display-width cap on a single preview row. */
export const QUEUE_PREVIEW_W = 70

/**
 * Glyph between the queue position and the preview text. U+25B8 BLACK
 * RIGHT-POINTING SMALL TRIANGLE — 1 cell wide in the codebase's
 * `displayWidth` model, dim-rendered (no accent color).
 */
export const QUEUE_ITEM_SEPARATOR = "▸"

/**
 * Background fill for the selected row in navigation mode. A dark violet
 * `rgb(55, 45, 85)` so the row reads as a contiguous highlighted bar that
 * belongs to the same violet family as the header, without washing out
 * the foreground text. Closed with `\x1b[49m` (background-only reset) so
 * any foreground SGR inside the row is unaffected.
 */
const SEL_BG_OPEN = bgRgb(55, 45, 85)
const SEL_BG_CLOSE = ANSI_CODES.BG_RESET

const dim = c.dim
const faintWhite = c.faintWhite
const violet = c.violet
const dimViolet = c.dimViolet
const brightViolet = c.violet
const selectedText = c.boldBrightWhite

/**
 * Left-edge marker glyph for the selected row (U+258C LEFT HALF BLOCK,
 * 1 cell wide). Replaces the structural `┊` / `╰` so the eye lands on
 * the selection instantly.
 */
const QUEUE_SELECTED_MARKER = "▌"

/**
 * Build the per-row preview text from a single queue entry: whitespace
 * collapsed, then display-width-aware truncation with a `(+Nch)` hint.
 */
function buildPreview(entry: string): string {
  const oneLine = entry.replace(/\s+/g, " ").trim()
  if (displayWidth(oneLine) <= QUEUE_PREVIEW_W) return oneLine
  const truncated = truncateDisplayWidth(oneLine, QUEUE_PREVIEW_W, "")
  // Code-point count (matches user mental model of "characters", not cells).
  // eslint-disable-next-line typescript-eslint/no-misused-spread
  const cpCut = [...oneLine].length - [...truncated].length
  return `${truncated}${truncHint(cpCut, "ch")}`
}

/** The violet `⏳ queued · N` header row, shared by both render paths. */
function buildHeader(count: number): string {
  // Header: violet `⏳ queued` (full color, no dim) + faint `· N` badge.
  // The count is intentionally dim so it reads as a trailing metadata
  // badge rather than competing with the label for attention.
  return `  ${violet("⏳")} ${violet("queued")} ${faintWhite(`· ${count}`)}`
}

/**
 * Plain-block header + a faint `↑ edit` affordance so the user discovers
 * the queue is interactive (↑ dequeues / opens the selection overlay).
 * The nav block omits this : its dedicated hint row already lists every
 * action, so repeating "↑ edit" there would be noise.
 */
function buildPlainHeader(count: number): string {
  return `${buildHeader(count)}${dim("  ·  ↑ edit")}`
}

/**
 * One non-selected item row. `glyph` is the structural `┊` (open) or
 * `╰` (closing). Hierarchy: dim glyph, dim-violet number, dim ▸, faint
 * preview — readable enough to re-scan without the block reading as
 * "fainted out".
 */
function buildItemRow(num: number, preview: string, glyph: "┊" | "╰"): string {
  return `  ${dim(glyph)}  ${dimViolet(`${num}`)} ${dim(QUEUE_ITEM_SEPARATOR)} ${faintWhite(preview)}`
}

/**
 * The selected item row: a full-width violet bar. When `cols` is known
 * the row is right-padded (inside the background) so the highlight spans
 * the whole terminal; otherwise only the content carries the bar. The
 * marker (`▌`) + number render in bright violet and the preview in bold
 * near-white so the selection is unmistakable.
 */
function buildSelectedRow(num: number, preview: string, cols?: number): string {
  const plain = `  ${QUEUE_SELECTED_MARKER}  ${num} ${QUEUE_ITEM_SEPARATOR} ${preview}`
  const styled = `  ${brightViolet(QUEUE_SELECTED_MARKER)}  ${brightViolet(`${num}`)} ${dim(
    QUEUE_ITEM_SEPARATOR,
  )} ${selectedText(preview)}`
  const plainW = displayWidth(plain)
  const pad = cols && cols > plainW ? " ".repeat(cols - plainW) : ""
  return `${SEL_BG_OPEN}${styled}${pad}${SEL_BG_CLOSE}`
}

/**
 * Footer hint row shown only in navigation mode. Teaches the action
 * keys: violet key-caps, dim labels, dim `·` separators. Carries the
 * closing `╰` so it visually terminates the block.
 */
function buildHintRow(): string {
  const pairs: Array<[string, string]> = [
    ["↑↓", "select"],
    ["d", "dequeue"],
    ["x", "remove"],
    ["k", "dequeue all"],
    ["esc", "cancel"],
  ]
  const hint = pairs.map(([k, label]) => `${violet(k)} ${dim(label)}`).join(dim(" · "))
  return `  ${dim("╰")} ${hint}`
}

/** Build the plain (non-interactive) block, with the `↑ edit` affordance. */
function buildPlainBlock(queue: readonly string[]): string[] {
  const count = queue.length
  const lines: string[] = [buildPlainHeader(count)]
  const visibleCount = Math.min(QUEUE_MAX_VISIBLE_ITEMS, count)
  const hasOverflow = count > QUEUE_MAX_VISIBLE_ITEMS
  for (let i = 0; i < visibleCount; i++) {
    const preview = buildPreview(queue[i])
    // Closing curve `╰` on the LAST visible row IFF no overflow tail
    // is appended below. With overflow, every item row stays `┊` and
    // the overflow tail carries `╰` instead.
    const isClosingRow = i === visibleCount - 1 && !hasOverflow
    lines.push(buildItemRow(i + 1, preview, isClosingRow ? "╰" : "┊"))
  }
  if (hasOverflow) {
    const remaining = count - QUEUE_MAX_VISIBLE_ITEMS
    lines.push(`  ${dim("╰")}  ${faintWhite(`... and ${remaining} more`)}`)
  }
  return lines
}

/**
 * Build the navigation block: a scroll window that always keeps the
 * selected row visible, the selected row rendered as a highlighted bar,
 * `↑ N more` / `↓ N more` elision rows when the window is clipped, and a
 * trailing hint row. Every item row uses `┊` (the hint row carries the
 * closing `╰`).
 */
function buildNavBlock(queue: readonly string[], selectedIndex: number, cols?: number): string[] {
  const count = queue.length
  const sel = Math.max(0, Math.min(count - 1, selectedIndex))
  const lines: string[] = [buildHeader(count)]

  // Window of up to QUEUE_MAX_VISIBLE_ITEMS rows that contains `sel`.
  // Centered-ish on the selection so navigating a deep queue scrolls
  // smoothly instead of jumping a page at a time.
  let start = 0
  if (count > QUEUE_MAX_VISIBLE_ITEMS) {
    start = sel - Math.floor(QUEUE_MAX_VISIBLE_ITEMS / 2)
    start = Math.max(0, Math.min(start, count - QUEUE_MAX_VISIBLE_ITEMS))
  }
  const end = Math.min(count, start + QUEUE_MAX_VISIBLE_ITEMS)

  if (start > 0) {
    lines.push(`  ${dim("┊")}  ${faintWhite(`↑ ${start} more`)}`)
  }
  for (let i = start; i < end; i++) {
    const preview = buildPreview(queue[i])
    if (i === sel) {
      lines.push(buildSelectedRow(i + 1, preview, cols))
    } else {
      lines.push(buildItemRow(i + 1, preview, "┊"))
    }
  }
  if (end < count) {
    lines.push(`  ${dim("┊")}  ${faintWhite(`↓ ${count - end} more`)}`)
  }
  lines.push(buildHintRow())
  return lines
}

/**
 * Build the decoration lines (header + item rows + optional overflow
 * tail). With `opts.selectedIndex` set, renders the interactive
 * navigation variant (selection bar + action hint) instead.
 */
export function buildQueueDecorationLines(
  queue: readonly string[],
  opts: { selectedIndex?: number | null; cols?: number } = {},
): string[] {
  if (queue.length === 0) return []
  const selectedIndex = opts.selectedIndex ?? null
  if (selectedIndex === null) return buildPlainBlock(queue)
  return buildNavBlock(queue, selectedIndex, opts.cols)
}

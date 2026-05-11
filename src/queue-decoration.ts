/**
 * Pure builder for the queued-message decoration block surfaced above
 * the editor prompt while an agent turn is in flight.
 *
 * Layout (n = queue.length):
 *
 *   `  ⏳ n queued`              <- header
 *   `  ┊  1 ▸ first preview`     <- item rows: position + ▸ + preview
 *   `  ┊  2 ▸ second preview`
 *   `  ╰  3 ▸ third preview`     <- last visible row uses `╰`
 *
 * Overflow (n > QUEUE_MAX_VISIBLE_ITEMS):
 *
 *   `  ⏳ n queued`
 *   `  ┊  1 ▸ first`
 *   `  …  (rows 2..10) …`
 *   `  ╰  ... and (n-10) more`   <- elision tail closes the block
 *
 * Numbering is 1-based so the digits line up under the header count
 * ("3 queued" → entries `1`, `2`, `3`). Item-row layout pads the
 * 1-cell `┊` / `╰` glyph with one extra space so its content column
 * aligns under the wide-emoji `⏳` (2 cells) in the header.
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
 */
import { displayWidth, truncateDisplayWidth } from "./term-width.ts"
import { truncHint } from "./truncate-hint.ts"

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

/** SGR dim wrapper. Inlined to keep this module dependency-light. */
const dim = (s: string): string => `\x1b[2m${s}\x1b[22m`

/** SGR dim+white. Matches `c.faintWhite` in agent.ts byte-for-byte. */
const faintWhite = (s: string): string => `\x1b[2;37m${s}\x1b[22;39m`

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

/** Build the decoration lines (header + item rows + optional overflow tail). */
export function buildQueueDecorationLines(queue: readonly string[]): string[] {
  if (queue.length === 0) return []
  const count = queue.length
  const header = `  ${faintWhite("⏳")} ${dim(`${count} queued`)}`
  const lines: string[] = [header]
  const visibleCount = Math.min(QUEUE_MAX_VISIBLE_ITEMS, count)
  const hasOverflow = count > QUEUE_MAX_VISIBLE_ITEMS
  for (let i = 0; i < visibleCount; i++) {
    const preview = buildPreview(queue[i])
    // Closing curve `╰` on the LAST visible row IFF no overflow tail
    // is appended below. With overflow, every item row stays `┊` and
    // the overflow tail carries `╰` instead.
    const isClosingRow = i === visibleCount - 1 && !hasOverflow
    const glyph = isClosingRow ? "╰" : "┊"
    const num = i + 1
    lines.push(`  ${dim(glyph)}  ${dim(`${num} ${QUEUE_ITEM_SEPARATOR} ${preview}`)}`)
  }
  if (hasOverflow) {
    const remaining = count - QUEUE_MAX_VISIBLE_ITEMS
    lines.push(`  ${dim("╰")}  ${dim(`... and ${remaining} more`)}`)
  }
  return lines
}

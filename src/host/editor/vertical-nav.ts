/**
 * Wrap-aware vertical cursor navigation for the {@link EditorController}:
 * "cursor up/down by one PHYSICAL row" over soft-wrapped logical lines,
 * with vim/VSCode-style sticky visual column.
 *
 * Extracted verbatim from `src/editor-controller.ts` so the controller
 * stays under the repo's `max-lines` budget; no behavior changes. The
 * navigator owns the sticky-column state ({@link desiredVisualCol} and
 * the endpoint stamp) and mutates the shared {@link EditorBuffer}
 * cursor directly.
 *
 * @module editor/vertical-nav
 */

import type { EditorBuffer } from "../../editor-buffer.ts"
import { displayWidth } from "../../terminal/term-width.ts"
import { computeCursorVisualPos, findColAtVisualPos } from "../ui/editor/renderer.ts"

/**
 * Per-row prompt geometry the navigator needs from the renderer:
 * display width of the prompt prefix for a given logical row (the
 * first row carries the prompt, continuation rows the continuation
 * prompt).
 */
export type PromptWidthForRow = (row: number) => number

/**
 * Sticky-column vertical movement over a shared {@link EditorBuffer}.
 *
 * One instance per controller; the controller delegates ArrowUp /
 * ArrowDown (when no plugin claims them) to {@link moveUp} /
 * {@link moveDown}.
 */
export class VerticalNavigator {
  /**
   * Sticky "preferred visual column" for wrap-aware up/down navigation.
   * Set on the FIRST up/down keystroke after any other move so a long
   * column of `j`/`k` (or arrow keys) walks straight up/down even past
   * short rows. Implicitly reset by {@link moveUp}/{@link moveDown}
   * when they detect the cursor has moved away from where the previous
   * vertical move parked it - see {@link lastVerticalEndRow}.
   *
   * Why no explicit "reset on every non-vertical action": doing so
   * would require touching ~30 keystroke handler sites (left/right,
   * line start/end, word jumps, every edit, paste, submit, abort,
   * etc.). The endpoint-match probe achieves the same semantics with
   * zero instrumentation cost - any action that mutates `buf.row`
   * or `buf.col` away from the last vertical-move endpoint invalidates
   * the sticky column on the next up/down keystroke.
   */
  private desiredVisualCol: number | null = null
  /**
   * Buffer (row, col) where the previous successful vertical move left
   * the cursor. {@link moveUp}/{@link moveDown} compare these to the
   * cursor's current position on entry - a mismatch means some
   * non-vertical action ran in between and the sticky column is stale.
   *
   * `null` means "no vertical move has happened yet this session" (or
   * a vertical move returned false because cursor couldn't move) -
   * treated as a mismatch, forcing a fresh sample.
   */
  private lastVerticalEndRow: number | null = null
  private lastVerticalEndCol: number | null = null

  constructor(
    private readonly buf: EditorBuffer,
    private readonly promptWidthForRow: PromptWidthForRow,
    private readonly columns: () => number | undefined,
  ) {}

  /**
   * Wrap-aware "cursor up by one PHYSICAL row". When the cursor sits on
   * the second-or-later wrap chunk of a long logical line, this moves it
   * up to the previous wrap chunk of the SAME logical line. Only when
   * the cursor is on the first wrap chunk does it cross into the prior
   * logical line (landing on that line's LAST wrap chunk, at the same
   * visual column).
   *
   * Sticky column ({@link desiredVisualCol}): when up/down navigation runs
   * consecutively, the cursor's visual column at the start of the run is
   * captured and reused. Standard vim/VSCode "keep column when walking
   * through short rows" behavior - without it, the cursor drifts to the
   * left edge through varied-width rows. The endpoint-match probe in
   * {@link isVerticalStickyAlive} invalidates the column automatically
   * whenever a non-vertical action moves the cursor between presses.
   *
   * Falls back to {@link EditorBuffer.moveUp} when the terminal width is
   * unknown (no wrap layout possible, e.g. non-TTY tests).
   *
   * Returns `true` when the cursor actually moved.
   */
  moveUp(): boolean {
    if (!this.isVerticalStickyAlive()) this.desiredVisualCol = null
    const cols = this.columns()
    if (!cols || cols <= 0) {
      const moved = this.buf.moveUp()
      this.recordVerticalEndpoint()
      return moved
    }
    const line = this.buf.lines[this.buf.row]
    const promptW = this.promptWidthForRow(this.buf.row)
    const cur = computeCursorVisualPos(line, this.buf.col, promptW, cols)
    if (this.desiredVisualCol === null) this.desiredVisualCol = cur.visualCol
    const target = this.desiredVisualCol
    if (cur.visualRow > 0) {
      // Same logical line, one wrap chunk up.
      const newCol = findColAtVisualPos(line, cur.visualRow - 1, target, promptW, cols)
      if (newCol === this.buf.col) {
        this.recordVerticalEndpoint()
        return false
      }
      this.buf.col = newCol
      this.recordVerticalEndpoint()
      return true
    }
    // First wrap chunk of this line → cross into previous logical line.
    if (this.buf.row === 0) {
      this.recordVerticalEndpoint()
      return false
    }
    const prevRow = this.buf.row - 1
    const prevLine = this.buf.lines[prevRow]
    const prevPromptW = this.promptWidthForRow(prevRow)
    const prevWidth = prevPromptW + displayWidth(prevLine)
    const prevRowCount = prevWidth <= 0 ? 1 : Math.max(1, Math.ceil(prevWidth / cols))
    const targetVisualRow = prevRowCount - 1
    const newCol = findColAtVisualPos(prevLine, targetVisualRow, target, prevPromptW, cols)
    this.buf.row = prevRow
    // EditorBuffer's `row` setter clamps `col`; we then set col explicitly
    // (the setter clamps to the line length, which is what we want when
    // the target visual col is past the end of the previous line).
    this.buf.col = newCol
    this.recordVerticalEndpoint()
    return true
  }

  /**
   * Wrap-aware "cursor down by one PHYSICAL row" - mirror of
   * {@link moveUp}. When more wrap chunks remain inside the current
   * logical line, walks down one chunk; otherwise crosses into the next
   * logical line and lands on its FIRST chunk, at the sticky visual col.
   */
  moveDown(): boolean {
    if (!this.isVerticalStickyAlive()) this.desiredVisualCol = null
    const cols = this.columns()
    if (!cols || cols <= 0) {
      const moved = this.buf.moveDown()
      this.recordVerticalEndpoint()
      return moved
    }
    const line = this.buf.lines[this.buf.row]
    const promptW = this.promptWidthForRow(this.buf.row)
    const cur = computeCursorVisualPos(line, this.buf.col, promptW, cols)
    if (this.desiredVisualCol === null) this.desiredVisualCol = cur.visualCol
    const target = this.desiredVisualCol
    if (cur.visualRow < cur.rowsInLine - 1) {
      // Same logical line, one wrap chunk down.
      const newCol = findColAtVisualPos(line, cur.visualRow + 1, target, promptW, cols)
      if (newCol === this.buf.col) {
        this.recordVerticalEndpoint()
        return false
      }
      this.buf.col = newCol
      this.recordVerticalEndpoint()
      return true
    }
    // Last wrap chunk of this line → cross into next logical line.
    if (this.buf.row >= this.buf.lines.length - 1) {
      this.recordVerticalEndpoint()
      return false
    }
    const nextRow = this.buf.row + 1
    const nextLine = this.buf.lines[nextRow]
    const nextPromptW = this.promptWidthForRow(nextRow)
    const newCol = findColAtVisualPos(nextLine, 0, target, nextPromptW, cols)
    this.buf.row = nextRow
    this.buf.col = newCol
    this.recordVerticalEndpoint()
    return true
  }

  /**
   * `true` when the cursor still sits where the last vertical move
   * parked it - i.e. no non-vertical action (left/right, edit, paste,
   * etc.) has run since. Drives the implicit reset of
   * {@link desiredVisualCol} so no other keystroke handler needs to
   * touch it.
   */
  private isVerticalStickyAlive(): boolean {
    return this.lastVerticalEndRow === this.buf.row && this.lastVerticalEndCol === this.buf.col
  }

  /**
   * Stamp the current cursor position as "where the last vertical move
   * ended". A subsequent {@link moveUp}/{@link moveDown} checks the
   * cursor against this stamp; if anything moved it in between, the
   * sticky column is dropped.
   *
   * Stamped even when the vertical move was a no-op at top/bottom, so a
   * follow-up up-arrow on the same row doesn't think the cursor
   * "drifted" and reset the sticky col.
   */
  private recordVerticalEndpoint(): void {
    this.lastVerticalEndRow = this.buf.row
    this.lastVerticalEndCol = this.buf.col
  }
}

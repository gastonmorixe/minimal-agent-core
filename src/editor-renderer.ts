/**
 * Pure transform from {@link EditorBuffer} state to a list of physical
 * terminal rows + a cursor position, ready to be handed to the
 * {@link Compositor} as a "live area" snapshot.
 *
 * When `columns` is provided to {@link EditorRenderer.render}, long logical
 * lines are pre-wrapped into chunks ≤ `columns` cells wide and the cursor
 * position is returned in **physical** row/col coordinates inside the live
 * area. Without `columns`, one physical row per logical line is emitted and
 * the cursor column is the raw `prompt + buf.col` (legacy MVP behavior;
 * relies on terminal-side wrap and breaks cursor placement for wrapped
 * lines — TTY callers should always pass `columns`).
 *
 * @module editor-renderer
 */

import type { EditorBuffer } from "./editor-buffer.ts"
import {
  codePointWidth,
  cursorRowOffset,
  cursorVisualCol,
  displayWidth,
  wrapRows,
} from "./term-width.ts"

export interface EditorRendererOptions {
  prompt: string
  continuationPrompt: string
  /**
   * When `true`, invisible characters are rendered as faint glyphs:
   * spaces → `·`, tabs → `→`, line-ends → `↵`. Useful for
   * debugging whitespace in multiline inputs.
   */
  showHidden?: boolean
}

export interface EditorRenderOptions {
  firstRow?: number
  rowCount?: number
  /**
   * Terminal width in cells. When provided, output lines are pre-wrapped to
   * fit within this width and the returned cursor is in physical
   * (post-wrap) coordinates. Strongly recommended for TTY callers — without
   * it the cursor column can exceed terminal width and get clamped to the
   * right edge by the terminal.
   */
  columns?: number
}

export class EditorRenderer {
  private prompt: string
  private continuationPrompt: string
  private promptWidth: number
  private continuationPromptWidth: number
  private showHidden: boolean

  constructor(opts: EditorRendererOptions) {
    this.prompt = opts.prompt
    this.continuationPrompt = opts.continuationPrompt
    this.promptWidth = displayWidth(opts.prompt)
    this.continuationPromptWidth = displayWidth(opts.continuationPrompt)
    this.showHidden = opts.showHidden ?? false
  }

  /**
   * Enable or disable visible rendering of invisible characters. Takes
   * effect on the next call to {@link render}.
   */
  setShowHidden(v: boolean): void {
    this.showHidden = v
  }

  /**
   * Update the prompt prefix(es). Used when the active mode changes and
   * the prompt label needs to reflect the new mode (e.g. `ASK ❯ `).
   * `continuationPrompt` is optional — pass undefined to keep the current.
   */
  setPrompt(prompt: string, continuationPrompt?: string): void {
    this.prompt = prompt
    this.promptWidth = displayWidth(prompt)
    if (continuationPrompt !== undefined) {
      this.continuationPrompt = continuationPrompt
      this.continuationPromptWidth = displayWidth(continuationPrompt)
    }
  }

  /**
   * Current prompt prefix string, with any ANSI styling intact. Read-only
   * accessor for callers that need to compose adjacent UI affordances
   * (e.g. the "↑ N more lines" scroll indicator in
   * {@link EditorController}, which prepends this prefix so the user can
   * always tell what mode is active even when the buffer is scrolled and
   * the natural prompt-bearing row is hidden above the viewport).
   */
  getPrompt(): string {
    return this.prompt
  }

  /**
   * Display width (in terminal cells) of {@link getPrompt}. Pre-computed
   * — `displayWidth` is not called per access.
   */
  getPromptDisplayWidth(): number {
    return this.promptWidth
  }

  /**
   * Display width (in terminal cells) of the continuation prompt used on
   * logical rows > 0. Used by the controller's wrap-aware up/down
   * navigation to compute which physical row a cursor sits on.
   */
  getContinuationPromptDisplayWidth(): number {
    return this.continuationPromptWidth
  }

  /**
   * Width of the prompt prefix used for a given logical row index: the
   * main prompt on row 0, the continuation prompt on later rows. Pure
   * accessor; pre-computed widths, no allocation.
   */
  promptDisplayWidthForRow(row: number): number {
    return row === 0 ? this.promptWidth : this.continuationPromptWidth
  }

  render(
    buf: EditorBuffer,
    opts?: EditorRenderOptions,
  ): {
    lines: string[]
    cursor: { row: number; col: number }
  } {
    const firstRow = Math.max(0, opts?.firstRow ?? 0)
    const totalRows = buf.lines.length
    const rowCount = Math.max(
      0,
      Math.min(opts?.rowCount ?? totalRows - firstRow, totalRows - firstRow),
    )
    const cols = opts?.columns
    const wrap = typeof cols === "number" && cols > 0

    const lines: string[] = []
    let cursorRow = 0
    let cursorCol = 0
    let cursorPlaced = false

    for (let i = 0; i < rowCount; i++) {
      const logical = firstRow + i
      const isFirstLogical = logical === 0
      const prompt = isFirstLogical ? this.prompt : this.continuationPrompt
      const promptW = isFirstLogical ? this.promptWidth : this.continuationPromptWidth
      const lineText = buf.lines[logical]

      if (!wrap) {
        const displayText = this.showHidden
          ? markHidden(lineText) + (logical < totalRows - 1 ? HIDDEN_NEWLINE : "")
          : lineText
        lines.push(prompt + displayText)
        if (logical === buf.row) {
          cursorRow = i
          cursorCol = promptW + buf.col
          cursorPlaced = true
        }
        continue
      }

      const startPhysical = lines.length
      const chunks = wrapContent(lineText, cols, promptW)
      if (this.showHidden) {
        // Apply show-hidden transform AFTER wrapping so width calculations
        // remain correct (wrapping uses the original text's display widths).
        const isNonLastLine = logical < totalRows - 1
        for (let k = 0; k < chunks.length; k++) {
          const transformed =
            markHidden(chunks[k]) + (isNonLastLine && k === chunks.length - 1 ? HIDDEN_NEWLINE : "")
          lines.push((k === 0 ? prompt : "") + transformed)
        }
      } else {
        for (let k = 0; k < chunks.length; k++) {
          lines.push((k === 0 ? prompt : "") + chunks[k])
        }
      }

      if (logical === buf.row) {
        const colW = displayWidthOfChars(lineText, buf.col)
        const total = promptW + colW
        const atExactFill = total > 0 && total % cols === 0
        if (atExactFill) {
          // Editor uses "post-insert" cursor placement: at a wrap boundary,
          // park the cursor at col 0 of the next physical row (where the
          // next typed character will land), not at col `cols` of the
          // current row (which terminals clamp onto the last printed cell,
          // making it look like the next keystroke will replace it).
          //
          // The next row already exists when there is more content after
          // buf.col; if the cursor is at end-of-line we materialize a
          // phantom empty row so it has a home.
          const atEndOfLine = buf.col === codePointCount(lineText)
          if (atEndOfLine) lines.push("")
          cursorRow = startPhysical + total / cols
          cursorCol = 0
        } else {
          cursorRow = startPhysical + cursorRowOffset(promptW, colW, cols)
          cursorCol = cursorVisualCol(promptW, colW, cols)
        }
        cursorPlaced = true
      }
    }

    if (!cursorPlaced) {
      // Cursor's logical row is outside the window — clamp to last visible
      // physical row, column 0 (best-effort; matches legacy behavior).
      cursorRow = Math.max(0, lines.length - 1)
      cursorCol = 0
    }

    return { lines, cursor: { row: cursorRow, col: cursorCol } }
  }

  /**
   * Number of physical terminal rows the buffer needs to render without
   * truncation. When `columns` is provided, accounts for soft-wrap of long
   * logical lines using a display-width model that handles ANSI, wide
   * glyphs and combining marks; otherwise returns one row per logical line
   * (legacy behavior).
   *
   * Callers driving a Compositor live area should always pass `columns` —
   * otherwise wrapped lines will spill out of the reserved live region.
   */
  measureRows(buf: EditorBuffer, columns?: number): number {
    if (!columns || columns <= 0) return buf.lines.length
    let total = 0
    for (let i = 0; i < buf.lines.length; i++) {
      const promptW = i === 0 ? this.promptWidth : this.continuationPromptWidth
      const w = promptW + displayWidth(buf.lines[i])
      let rows = wrapRows(w, columns)
      // Phantom row when the cursor sits at end of an exact-fill line —
      // must match the renderer's `lines.push("")` branch above.
      if (i === buf.row && buf.col === codePointCount(buf.lines[i]) && w > 0 && w % columns === 0) {
        rows += 1
      }
      total += rows
    }
    return Math.max(1, total)
  }
}

/**
 * Display width of the first `charCount` code points of `text`. `charCount`
 * is in code-point units (matching {@link EditorBuffer}'s column model).
 */
/** Number of code points in `text` (matches EditorBuffer's column model). */
function codePointCount(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    i += cp > 0xffff ? 2 : 1
    n += 1
  }
  return n
}

function displayWidthOfChars(text: string, charCount: number): number {
  let width = 0
  let consumed = 0
  for (let i = 0; i < text.length && consumed < charCount; ) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    width += codePointWidth(cp)
    i += cp > 0xffff ? 2 : 1
    consumed += 1
  }
  return width
}

/**
 * Visual position of a cursor sitting `col` code points into a logical line
 * `text` whose prompt prefix occupies `promptW` cells, in a terminal of
 * `cols` cells wide.
 *
 * - `visualRow` (0-based) is the physical row within the logical line.
 * - `visualCol` (0-based, 0..cols-1) is the cell column within `visualRow`.
 * - `rowsInLine` is how many physical rows the whole logical line occupies.
 *
 * Returns `{ visualRow: 0, visualCol: promptW, rowsInLine: 1 }` when
 * `cols <= 0` (no-wrap layout). Callers should treat that as "no visual
 * navigation possible" and fall back to logical row movement.
 *
 * Used by the controller's wrap-aware up/down arrow navigation so a long
 * wrapped logical line walks visual row at a time instead of jumping the
 * whole line per keystroke.
 */
export function computeCursorVisualPos(
  text: string,
  col: number,
  promptW: number,
  cols: number,
): { visualRow: number; visualCol: number; rowsInLine: number } {
  if (cols <= 0) {
    return { visualRow: 0, visualCol: promptW, rowsInLine: 1 }
  }
  const colCells = displayWidthOfChars(text, col)
  const totalCells = promptW + colCells
  const lineWidth = promptW + displayWidth(text)
  // Use the same wrap math as the renderer. Both `cursorRowOffset` and
  // `cursorVisualCol` (from term-width.ts) park the exact-fill cursor at
  // the end of the current row; we follow the same convention so the
  // visual position we return matches what the user sees.
  const visualRow = totalCells <= 0 ? 0 : Math.floor(Math.max(0, totalCells - 1) / cols)
  const mod = totalCells === 0 ? 0 : totalCells % cols
  const visualCol = mod === 0 && totalCells > 0 ? cols : mod
  const rowsInLine = lineWidth <= 0 ? 1 : Math.max(1, Math.ceil(lineWidth / cols))
  return { visualRow, visualCol, rowsInLine }
}

/**
 * Inverse of {@link computeCursorVisualPos}: given a logical line, a
 * target physical row within that line, and a desired visual column
 * (cell offset from the left edge), return the buffer's code-point
 * column the cursor should sit at.
 *
 * - `targetVisualRow` is 0-based within the logical line; values
 *   beyond the line's actual `rowsInLine` are clamped to the last row.
 * - `targetVisualCol` is 0-based and may be greater than the content
 *   of the target row, in which case the cursor lands at end-of-row
 *   (or end-of-line on the last row, matching the "stop at the visible
 *   tail" UX users expect from arrow nav).
 *
 * The prompt prefix of `promptW` cells occupies the head of `visualRow=0`,
 * so a `targetVisualRow=0`, `targetVisualCol=0` request returns col 0
 * regardless of `promptW` (the cursor parks just after the prompt; the
 * caller doesn't see negative columns).
 */
export function findColAtVisualPos(
  text: string,
  targetVisualRow: number,
  targetVisualCol: number,
  promptW: number,
  cols: number,
): number {
  if (cols <= 0 || targetVisualRow < 0) return 0
  // Total cells from line start to target visual position.
  const rowStartCells = targetVisualRow * cols
  // First row starts after the prompt; later rows start at col 0.
  const targetTotalCells = rowStartCells + targetVisualCol
  // Walk the line counting cells until we exceed targetTotalCells - promptW.
  const targetContentCells = Math.max(0, targetTotalCells - promptW)
  let cells = 0
  let col = 0
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    const ch = String.fromCodePoint(cp)
    const w = codePointWidth(cp)
    // If consuming this char would put us past the target, stop here.
    // Tie-break: when `cells + w === targetContentCells` we consume (the
    // cursor sits AFTER the char, which is how all other editors render
    // a cursor at the right edge of a glyph).
    if (cells + w > targetContentCells) return col
    cells += w
    col += 1
    i += ch.length
  }
  return col
}

/**
 * Split plain `text` into chunks such that each chunk's display width fits
 * within the available cells of its physical row. The first chunk is sized
 * for `cols - firstPromptW` cells (because the prompt occupies the head of
 * the first physical row); subsequent chunks get the full `cols` width.
 *
 * Always returns at least one chunk (possibly empty) so the caller can
 * still emit the prompt-only row for empty buffers.
 */
function wrapContent(text: string, cols: number, firstPromptW: number): string[] {
  const result: string[] = []
  const firstCap = Math.max(1, cols - firstPromptW)
  let cap = firstCap
  let cur = ""
  let curW = 0
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    const ch = String.fromCodePoint(cp)
    const w = codePointWidth(cp)
    i += ch.length
    if (curW + w > cap) {
      result.push(cur)
      cur = ""
      curW = 0
      cap = cols
    }
    cur += ch
    curW += w
  }
  if (result.length === 0 || cur.length > 0) result.push(cur)
  return result
}

/**
 * Faint newline glyph appended at the end of every non-last logical line
 * when show-hidden mode is active.
 */
const HIDDEN_NEWLINE = "\x1b[2m\u21b5\x1b[22m"

/**
 * Replace invisible characters with faint visual indicator glyphs.
 *
 * | Character | Replacement | Meaning            |
 * |-----------|-------------|-------------------- |
 * | SPACE     | `·`         | U+00B7 MIDDLE DOT  |
 * | TAB       | `→`         | U+2192 RIGHTWARDS ARROW |
 *
 * ANSI escape sequences already present in the text are passed through
 * untouched (the renderer normally passes plain user input here, but
 * callers should be aware).
 *
 * Width contract: each substituted glyph occupies exactly one terminal
 * cell — the same as the original character — so cursor positions
 * computed from the untransformed text remain valid.
 */
function markHidden(text: string): string {
  let out = ""
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    i += ch.length
    if (ch === " ") {
      out += "\x1b[2m\u00b7\x1b[22m" // · MIDDLE DOT
    } else if (ch === "\t") {
      out += "\x1b[2m\u2192\x1b[22m" // → RIGHTWARDS ARROW
    } else {
      out += ch
    }
  }
  return out
}

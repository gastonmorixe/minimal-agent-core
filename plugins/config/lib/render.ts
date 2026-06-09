/**
 * Pure renderer for the `/config` overlay.
 *
 * Takes a plain {@link RenderModel} (rows + selection + phase + meta) and
 * returns the ANSI lines painted into the editor's footer band (same slot
 * the slash-menu uses, via `editor.footer.set`). No host imports, no I/O.
 *
 * Output rows are width-clamped so a wide value never wraps the live area.
 *
 * @module config/lib/render
 */

import { dim, padRight, SGR, truncateVisible, visualWidth, wrap } from "./palette.ts"

/** A row as the renderer sees it. */
export type RenderRow =
  | {
      type: "field"
      label: string
      /** Pretty value string (already resolved staged-vs-disk). */
      valueText: string
      /** True when this field has a pending (unsaved) edit. */
      dirty: boolean
      /** True when the value is unset (renders dim). */
      unset: boolean
      /** Hint about how the value is edited (e.g. "←/→", "⏎ edit"). */
      affordance: string
    }
  | { type: "section"; label: string }
  | { type: "action"; label: string; tone: "save" | "revert" | "close"; disabled?: boolean }

export interface RenderModel {
  /** Absolute config path (shown in the header). */
  path: string
  /** Flattened rows, in display order. Section headers are non-selectable. */
  rows: RenderRow[]
  /**
   * Index into the SELECTABLE rows (fields + actions, NOT section headers).
   * The renderer maps it to the right visual row.
   */
  selectedSelectableIndex: number
  /** Count of staged edits not yet written. */
  dirtyCount: number
  /** Editing phase. In "edit" we show the inline draft + edit hints. */
  phase: { kind: "browse" } | { kind: "edit"; label: string; draft: string }
  /** A parse error blocking edits (renders a red banner instead of rows). */
  error?: string | null
  /** Terminal width. */
  cols: number
  /** Max field/action rows to show at once (excludes header/divider/hint). */
  maxRows: number
}

const INDENT = "  "
const ARROW = "►"

/** Map a visual row list to selectable indices (field/action rows only). */
function selectableIndices(rows: RenderRow[]): number[] {
  const out: number[] = []
  rows.forEach((r, i) => {
    if (r.type === "field" || r.type === "action") out.push(i)
  })
  return out
}

/**
 * Render the overlay to ANSI lines. Always returns at least the header +
 * a hint line, so the footer band height is stable.
 */
export function render(model: RenderModel): string[] {
  const cols = Math.max(20, model.cols)
  const lines: string[] = []

  // Header: [icon] title  <chip>  <path>, then a full-width rule. This is the
  // common command-TUI chrome: header line, top divider, content, bottom
  // divider, footer hint.
  const title = wrap("⚙ config", SGR.boldSky)
  const dirtyChip =
    model.dirtyCount > 0
      ? "  " + wrap(`● ${model.dirtyCount} unsaved`, SGR.gold)
      : "  " + dim("(saved)")
  lines.push(clamp(INDENT + title + dirtyChip + "  " + dim(model.path), cols))
  lines.push(renderRule(cols))

  if (model.error) {
    lines.push(clamp(INDENT + wrap(`parse error: ${model.error}`, SGR.boldRed), cols))
    lines.push(clamp(INDENT + dim("fix the file by hand, then reopen · esc close"), cols))
    return lines
  }

  // Body: window the selectable rows around the selection, but keep section
  // headers that bound the visible window.
  const selectables = selectableIndices(model.rows)
  const selVisual = selectables[clampIdx(model.selectedSelectableIndex, selectables.length)] ?? -1
  const window = computeWindow(model.rows, selVisual, model.maxRows)

  let lastSection = ""
  for (let i = window.start; i < window.end; i++) {
    const row = model.rows[i]!
    if (row.type === "section") {
      lastSection = row.label
      lines.push(clamp(INDENT + wrap(row.label.toUpperCase(), SGR.dimViolet), cols))
      continue
    }
    const isSel = i === selVisual
    lines.push(renderRow(row, isSel, cols, model.phase))
  }
  void lastSection

  lines.push(renderDivider(model, window, cols))
  lines.push(renderHint(model, cols))
  return lines
}

function renderRow(
  row: Extract<RenderRow, { type: "field" | "action" }>,
  isSel: boolean,
  cols: number,
  phase: RenderModel["phase"],
): string {
  const gutter = isSel ? wrap(ARROW, SGR.boldSky) : " "

  if (row.type === "action") {
    const color =
      row.tone === "save" ? SGR.boldLime : row.tone === "revert" ? SGR.gold : SGR.faintWhite
    const label = row.disabled ? dim(row.label) : wrap(row.label, isSel ? color : SGR.faintWhite)
    return clamp(`${INDENT}${gutter} ${label}`, cols)
  }

  // Field row: [arrow] label …… value  [affordance]
  const labelColor = isSel ? SGR.boldWhite : SGR.white
  const label = wrap(row.label, labelColor)
  const LABEL_W = 22

  // In edit phase, the selected field shows the live draft + a caret.
  let valueCell: string
  if (isSel && phase.kind === "edit") {
    valueCell = wrap(phase.draft + "▏", SGR.boldSky)
  } else if (row.unset) {
    valueCell = dim(row.valueText)
  } else {
    valueCell = wrap(row.valueText, row.dirty ? SGR.gold : SGR.lime)
  }

  const dirtyDot = row.dirty ? wrap("●", SGR.gold) + " " : ""
  const affordance = isSel ? dim("  " + row.affordance) : ""

  const left = `${INDENT}${gutter} ${padRight(label, LABEL_W)}`
  const composed = `${left}${dirtyDot}${valueCell}${affordance}`
  return clamp(composed, cols)
}

interface Window {
  start: number
  end: number
  hiddenBelow: number
  hiddenAbove: number
}

/** Compute a visible window over `rows` keeping `selVisual` in view. */
function computeWindow(rows: RenderRow[], selVisual: number, maxRows: number): Window {
  // We budget `maxRows` for NON-section rows; section headers are cheap and
  // ride along. Simple approach: expand a window around the selection.
  const total = rows.length
  if (total <= maxRows) return { start: 0, end: total, hiddenAbove: 0, hiddenBelow: 0 }

  let start = Math.max(0, selVisual - Math.floor(maxRows / 2))
  let end = Math.min(total, start + maxRows)
  start = Math.max(0, end - maxRows)
  // Pull in a preceding section header if the window starts mid-section.
  if (start > 0 && rows[start]?.type !== "section") {
    for (let i = start - 1; i >= 0; i--) {
      if (rows[i]?.type === "section") {
        start = i
        break
      }
    }
  }
  const hiddenAbove = countNonSection(rows, 0, start)
  const hiddenBelow = countNonSection(rows, end, total)
  return { start, end, hiddenAbove, hiddenBelow }
}

function countNonSection(rows: RenderRow[], a: number, b: number): number {
  let n = 0
  for (let i = a; i < b; i++) if (rows[i]?.type !== "section") n++
  return n
}

/** A plain full-width dim rule (the top divider under the header). */
function renderRule(cols: number): string {
  const dashes = Math.max(4, cols - INDENT.length - 1)
  return INDENT + dim("\u2500".repeat(dashes))
}

function renderDivider(model: RenderModel, w: Window, cols: number): string {
  const notes: string[] = []
  if (w.hiddenAbove > 0) notes.push(`↑ ${w.hiddenAbove}`)
  if (w.hiddenBelow > 0) notes.push(`↓ ${w.hiddenBelow} more`)
  const note = notes.join("  ")
  const noteW = note ? 2 + visualWidth(note) : 0
  const dashes = Math.max(4, cols - INDENT.length - noteW - 1)
  let line = INDENT + dim("─".repeat(dashes))
  if (note) line += "  " + dim(note)
  return clamp(line, cols)
}

function renderHint(model: RenderModel, cols: number): string {
  const sep = `${SGR.dim} · ${SGR.reset}`
  const chips: string[] =
    model.phase.kind === "edit"
      ? [fw("type to edit"), fw("⏎ confirm"), fw("esc cancel")]
      : [fw("↑↓ move"), fw("←/→ change"), fw("⏎ edit/run"), fw("esc close")]
  const line = INDENT + chips.join(sep)
  return clamp(line, cols)
}

function fw(s: string): string {
  return `${SGR.faintWhite}${s}${SGR.reset}`
}

function clamp(line: string, cols: number): string {
  if (visualWidth(line) <= cols) return line
  return truncateVisible(line, cols)
}

function clampIdx(i: number, len: number): number {
  if (len === 0) return 0
  return Math.max(0, Math.min(len - 1, i))
}

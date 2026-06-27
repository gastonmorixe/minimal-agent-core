/**
 * Startup banner tree renderer for the CLI entry point.
 *
 * Draws the rounded `╭ │ │ ╰` tree on stderr at boot: the wordmark
 * header (with cat mascot), one row per startup fact (session, auth,
 * model, …), the wrapping `tools` row, the animated spinner row, and
 * the in-place `╰` closer.
 *
 * Stateful by design: the module tracks the last printed logical row so
 * {@link closeStartupTree} can rewrite its gutter glyph, and a single
 * visibility flag (set once at boot via {@link setStartupTreeVisible})
 * gates every printer so non-interactive runs stay silent.
 *
 * Split out of `src/index.ts` to keep that file under the `max-lines`
 * lint budget.
 *
 * @module ui/startup/tree
 */

import { AGENT_VERSION } from "../../build-info.ts"
import { displayWidth, truncateDisplayWidth, wrapRows } from "../../term-width.ts"
import { catRows, DEFAULT_CAT } from "../chrome/mascot.ts"
import { formatStartupToolsRow, wrapStartupToolsRows } from "../chrome/startup-tools-row.ts"
import { BREATHING_DOT } from "../spinner/library/frames.ts"
import { ANSI_PALETTE_RAINBOW } from "../spinner/library/palettes.ts"
import { c } from "../style/ansi.ts"

/**
 * Whether the startup tree prints at all. Set once at boot from
 * `resolveShowHeader` (precedence: CLI flag, then env, then config,
 * then the non-interactive default); every printer below no-ops when
 * false so callers never need to thread the flag.
 */
let SHOW_HEADER = false

/**
 * Set the tree's visibility for the rest of the process. Called once
 * by `src/index.ts` right after it resolves the header preference.
 */
export function setStartupTreeVisible(show: boolean): void {
  SHOW_HEADER = show
}

/**
 * Pad `line` with spaces on the right so its visible width reaches
 * `targetCol`. ANSI escapes are excluded from width math. If `line`
 * is already wider than `targetCol`, returned unchanged (no truncation).
 */
function padTo(line: string, targetCol: number): string {
  const w = displayWidth(line)
  if (w >= targetCol) return line
  return line + " ".repeat(targetCol - w)
}

// Visible-cell count of the fixed chrome that precedes the value in every
// startup row: "  │ " (4) + label.padEnd(9) (9) + "  " (2) = 15 cells.
const STARTUP_ROW_OVERHEAD = 15

/** Styled tree gutter glyphs. Body rows use `│`; the tree closes with `╰`. */
const TREE_BODY_GUTTER = c.faintWhite("│")
const TREE_CLOSE_GUTTER = c.faintWhite("╰")

/** Current stderr terminal width, falling back to 80 for non-TTY / unknown. */
function stderrCols(): number {
  return (process.stderr as { columns?: number }).columns ?? 80
}

/**
 * Truncate a startup-row value so the full row fits on a single terminal
 * line. Prevents wrapped rows from confusing the cursor-up math in
 * `closeStartupTree` and keeps the tree visually compact on narrow terminals.
 */
function fitRowValue(value: string): string {
  const cols = stderrCols()
  const maxWidth = Math.max(0, cols - STARTUP_ROW_OVERHEAD)
  return truncateDisplayWidth(value, maxWidth)
}

/**
 * The last logical startup row, stored as the exact physical line strings
 * that were printed (each already includes the `│` gutter + label column).
 * A row is usually one physical line, but the `tools` row can span several
 * (it wraps instead of truncating). {@link closeStartupTree} rewrites this
 * block in place to swap the final line's `│` gutter for the closing `╰`.
 */
let lastStartupRow: { lines: string[] } | null = null

/** Print the wordmark header (two title lines + cat mascot + a `│` spacer). */
export function printStartupHeader(): void {
  if (!SHOW_HEADER) return
  const by = c.faintWhite(c.italic("by"))
  const author = c.faintWhite(c.italic("Gaston Morixe"))
  const sep = c.faintWhite("·")
  const url = c.faintWhite(c.italic("github.com/gastonmorixe/minimal-agent"))
  // Rounded tree: ╭ for the opener, │ for body rows, ╰ to close.
  // Standard Unicode has no rounded ├ tee, so we drop the middle tee
  // entirely and rely on the first/last rounded corners to give the
  // tree a softer, more curved feel.
  const line1 = `  ${c.faintWhite("╭")} ${c.bold(c.pink("minimal-agent"))} ${c.faintWhite(`v${AGENT_VERSION}`)}`
  // Truncate line2 to terminal width so it never wraps and leaves an
  // unstyled continuation on narrow terminals (e.g. mobile-sized 52-col).
  const cols = stderrCols()
  const line2Full = `  ${c.faintWhite("│")} ${by} ${author} ${sep} ${url}`
  const line2 = truncateDisplayWidth(line2Full, cols)

  // Tiny cat mascot, anchored a fixed gap after the LONGER of the two
  // header lines — not flush to the terminal's right edge. Anchoring
  // to the terminal width means a resize re-flows the cat sideways
  // and breaks alignment between line 1 and line 2; anchoring to the
  // header content keeps the cat glued to the wordmark forever.
  //
  // We only use the top two rows of the 3-row cat (ears + face) because
  // the third header line is just `│` and the user's request was the
  // two title lines specifically. Faint color so the cat doesn't
  // upstage the wordmark.
  const [ears, face /*, mouth */] = catRows(DEFAULT_CAT)
  const GAP = 4 // spaces between header text and cat
  const anchorCol = Math.max(displayWidth(line1), displayWidth(line2)) + GAP
  // If the terminal is too narrow to fit even the cat, drop it rather
  // than wrap. The cat's widest row is `( ^.^ )` ≈ 7 cells; require
  // anchorCol + catWidth ≤ columns, otherwise skip.
  const catWidth = Math.max(displayWidth(ears), displayWidth(face))
  const fits = anchorCol + catWidth <= cols

  // Breathing room between the user's shell prompt and our banner when
  // running interactively. Skipped on non-TTY (piped/redirected stderr)
  // so log files don't gain a stray leading blank line.
  if (process.stderr.isTTY) console.error("")
  console.error(fits ? padTo(line1, anchorCol) + c.faintWhite(ears) : line1)
  console.error(fits ? padTo(line2, anchorCol) + c.faintWhite(face) : line2)
  console.error(`  ${c.faintWhite("│")}`)
}

/** Print one single-line startup row (`│ label  value`, value truncated to fit). */
export function printStartupRow(label: string, value: string): void {
  if (!SHOW_HEADER) return
  const v = fitRowValue(value)
  const row = `  ${TREE_BODY_GUTTER} ${c.sky(label.padEnd(9))}  ${v}`
  console.error(row)
  lastStartupRow = { lines: [row] }
}

/**
 * Print the `tools` row, wrapping the tool list across as many physical
 * lines as the terminal width needs instead of truncating it with `…`.
 * Continuation lines repeat the `│` gutter and leave the label column
 * blank so the names line up under the first row's value column.
 *
 * Why this is its own function: the generic {@link printStartupRow}
 * truncates to a single line (fine for `model`, `session`, etc.), but the
 * tools row is the one place users want the full inventory visible. The
 * wrap also keeps {@link closeStartupTree}'s cursor math honest — every
 * emitted line fits within the terminal width, so the "one logical row =
 * one physical line" assumption that used to break on the over-long,
 * emoji-containing tools row holds again.
 */
export function printStartupToolsRow(
  tools: ReadonlyArray<{ name: string; icon?: string; color?: string }>,
): void {
  if (!SHOW_HEADER) return
  const cols = stderrCols()
  const maxWidth = Math.max(1, cols - STARTUP_ROW_OVERHEAD)
  const valueLines = wrapStartupToolsRows(tools, maxWidth)
  if (valueLines.length === 0) return
  const blankLabel = " ".repeat(9)
  const printed: string[] = []
  valueLines.forEach((value, i) => {
    const label = i === 0 ? c.sky("tools".padEnd(9)) : blankLabel
    const row = `  ${TREE_BODY_GUTTER} ${label}  ${value}`
    console.error(row)
    printed.push(row)
  })
  lastStartupRow = { lines: printed }
}

/**
 * Close the startup tree with the tools list as the final row, using the
 * `╰` closer directly. No cursor-up rewrite, no manual wrapping — the
 * value is printed as a single line and the terminal handles any overflow.
 *
 * Because there is no cursor math, terminal resize between frame draw and
 * close cannot misplace the closer. This replaces the previous pattern of
 * printing a multiline `printStartupToolsRow` + `closeStartupTree()`, where
 * the cursor-up math broke when the terminal width changed.
 *
 * When tools is empty this delegates to {@link closeStartupTree} so the
 * tree still closes on whatever row was printed last.
 */
export function closeStartupTreeWithTools(
  tools: ReadonlyArray<{ name: string; icon?: string; color?: string }>,
): void {
  if (!SHOW_HEADER) return
  const value = formatStartupToolsRow(tools)
  if (value === null) {
    closeStartupTree()
    return
  }
  const row = `  ${TREE_CLOSE_GUTTER} ${c.sky("tools".padEnd(9))}  ${value}`
  console.error(row)
  lastStartupRow = null
}

/**
 * Close the startup tree by rewriting the last `│` row with `╰`.
 *
 * On a TTY we walk the cursor up to the start of the last row and erase
 * everything to end-of-screen before reprinting with the closing corner,
 * so the tree terminates visually on its final entry (e.g. `╰ quota   ok`).
 * Using `\x1b[J` (erase to end of screen) instead of `\x1b[2K` (erase
 * current line only) handles the edge case where the previous row wrapped
 * to multiple physical lines — all continuation lines are cleared cleanly.
 *
 * On non-TTY output (pipes, redirects) we just append a standalone `╰`
 * closer line since cursor motion wouldn't render.
 */
export function closeStartupTree(): void {
  if (!SHOW_HEADER) return
  if (!lastStartupRow) return
  const { lines } = lastStartupRow
  lastStartupRow = null
  if (lines.length === 0) return
  // The closer swaps the body gutter (`│`) for the rounded corner (`╰`) on
  // the FINAL physical line of the last logical row. Continuation lines of
  // a wrapped tools row keep their `│` so the tree stays connected.
  const closedLines = lines.slice()
  const lastIdx = closedLines.length - 1
  closedLines[lastIdx] = closedLines[lastIdx]!.replace(TREE_BODY_GUTTER, TREE_CLOSE_GUTTER)
  if (process.stderr.isTTY) {
    const cols = stderrCols()
    // How many physical lines did the last logical row occupy? Each stored
    // line is pre-wrapped to fit the terminal width, so this is almost
    // always `lines.length`, but we sum wrapRows() defensively in case a
    // future caller bypasses the width-fitting helpers.
    const physLines = lines.reduce((sum, line) => sum + wrapRows(displayWidth(line), cols), 0)
    // Go up to the start of the first stored line, then erase from cursor to
    // end of screen (clears every physical line of the row + any wrap).
    process.stderr.write(`\x1b[${physLines}A\x1b[J`)
    for (const line of closedLines) console.error(line)
  } else {
    console.error(`  ${TREE_CLOSE_GUTTER}`)
  }
}

/**
 * Print a startup row that animates a breathing-dot spinner while an async
 * task runs, then resolves to a final value in-place.
 *
 * Returns `{ ok(value), fail(value) }` — call one of them when the task
 * settles to overwrite the spinner with the final state and advance the
 * cursor. `lastStartupRow` is updated so `closeStartupTree` works correctly.
 *
 * On non-TTY output the spinner is skipped and only the final value prints.
 */
export function startStartupRowSpinner(
  label: string,
  checking: string,
): {
  ok(value: string): void
  fail(value: string): void
} {
  // Header suppressed (typical for non-interactive `--prompt` runs):
  // no rows, no spinner, no settle output. Callers don't need to know.
  if (!SHOW_HEADER) {
    return { ok() {}, fail() {} }
  }
  const PIPE = `  ${c.faintWhite("│")} `
  const prefix = `${PIPE}${c.sky(label.padEnd(9))}  `

  // Non-TTY: no cursor tricks — just print the row when settled.
  if (!process.stderr.isTTY) {
    return {
      ok(value) {
        const v = fitRowValue(value)
        const row = `${prefix}${v}`
        console.error(row)
        lastStartupRow = { lines: [row] }
      },
      fail(value) {
        const v = fitRowValue(value)
        const row = `${prefix}${v}`
        console.error(row)
        lastStartupRow = { lines: [row] }
      },
    }
  }

  let frameIdx = 0
  let colorIdx = 0

  function coloredDot(): string {
    const char = BREATHING_DOT[frameIdx] ?? "·"
    return ANSI_PALETTE_RAINBOW[colorIdx % ANSI_PALETTE_RAINBOW.length]!(char)
  }

  // Print the first frame immediately (no trailing newline — will be overwritten).
  process.stderr.write(`${prefix}${coloredDot()} ${checking}`)

  const timer = setInterval(() => {
    frameIdx = (frameIdx + 1) % BREATHING_DOT.length
    colorIdx++
    process.stderr.write(`\r${prefix}${coloredDot()} ${checking}`)
  }, 160)

  function settle(value: string): void {
    clearInterval(timer)
    const v = fitRowValue(value)
    process.stderr.write(`\r\x1b[2K${prefix}${v}\n`)
    lastStartupRow = { lines: [`${prefix}${v}`] }
  }

  return {
    ok: settle,
    fail: settle,
  }
}

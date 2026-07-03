/**
 * Pure builder for the one-time "status ready" hint banner that appears
 * above the REPL prompt at session start.
 *
 * Lifted out of `src/agent.ts` so the banner can be written ONCE from
 * `src/index.ts`, BEFORE any resume replay. Previously the banner was
 * emitted from inside `runRepl` / `runReplLiveArea`, which on resume
 * placed it BELOW the replayed content (visible jump: header → replay
 * → hint, instead of header → hint → replay).
 *
 * The trailing `\n\n` (NOT `\n`) is load-bearing: it provides the one
 * blank row of breathing room between the hint row and whatever comes
 * next (resume separator, prompt, etc.). The compositor's
 * `capBlankLines` caps consecutive `\n` runs in scrollback at 2, so a
 * single blank row is the max we'll ever see even if downstream code
 * adds more.
 *
 * @module ready-banner
 */

import type { ModeManager } from "../../../modes/modes.ts"
import { displayWidth } from "../../../terminal/term-width.ts"
import { c } from "../style/ansi.ts"

/** Separator between hint chunks: two spaces, a mid-dot, two spaces. */
const SEP = "  ·  "

/**
 * Distribute `chunks` across lines so each line's visible width stays
 * within `maxWidth`. Lines are indented with `indent`. Chunks are joined
 * by `SEP`; when a chunk doesn't fit on the current line it starts a new
 * one (never split mid-chunk).
 */
function wrapChunks(chunks: string[], indent: string, maxWidth: number): string {
  const sepWidth = displayWidth(SEP)
  const indentWidth = displayWidth(indent)
  const lines: string[] = []
  let line = ""
  let lineWidth = indentWidth

  for (const chunk of chunks) {
    const chunkWidth = displayWidth(chunk)
    if (line === "") {
      // First chunk on this line.
      line = chunk
      lineWidth = indentWidth + chunkWidth
    } else if (lineWidth + sepWidth + chunkWidth <= maxWidth) {
      // Fits: append to current line.
      line += SEP + chunk
      lineWidth += sepWidth + chunkWidth
    } else {
      // Doesn't fit: flush current line and start a new one.
      lines.push(indent + line)
      line = chunk
      lineWidth = indentWidth + chunkWidth
    }
  }
  if (line !== "") lines.push(indent + line)
  return lines.join("\n")
}

/**
 * Build the dim/colored banner string. Pure : no I/O, no side effects.
 *
 * @param modeManager - When non-null AND `hasModes()` is true, appends a
 *   `· shift+tab cycle mode` tail to the hint row.
 * @param cols - Terminal width in columns. Hint chunks are reflowed across
 *   multiple indented lines when they don't all fit on one line. Defaults
 *   to 80 (wide enough to fit everything on a single line).
 * @returns ANSI-tagged banner: `\n  status ready\n  <hints>\n\n`.
 */
export function buildReadyBanner(modeManager: ModeManager | null, cols = 80): string {
  const dot = c.faintWhite("·")
  const chunks: string[] = [
    `${c.faintWhite("enter")} ${c.bold("send")}`,
    `${c.faintWhite("shift+enter")} ${c.bold("new line")}`,
    `${c.faintWhite("ctrl+c")} ${c.bold("quit")}`,
  ]
  if (modeManager && modeManager.hasModes()) {
    chunks.push(`${c.faintWhite("shift+tab")} ${c.bold("cycle mode")}`)
    chunks.push(`${c.faintWhite("alt+m")} ${c.bold("apply mode now")}`)
  }
  // Replace the plain " · " separators in SEP with the styled dot for
  // the final render. wrapChunks uses displayWidth(SEP) for math, so it
  // measures the raw separator string (5 cells). The styled version has
  // the same visual width; we patch after layout.
  const styledSep = `  ${dot}  `
  const hintBlock = wrapChunks(chunks, "  ", cols).replace(/  ·  /g, styledSep)
  return `\n  ${c.bold(c.purple("status"))} ${c.faintWhite("ready")}\n${hintBlock}\n\n`
}

/**
 * Compositor — pins a "live area" (status row + multiline editor) to the
 * line just below the most recent terminal output, while letting all
 * streamed output scroll into the terminal's native scrollback like any
 * normal program would.
 *
 * **Why not DEC scroll regions (DECSTBM)?**
 * A scroll region pins UI rows at the bottom of the viewport, but lines
 * that scroll off the *top* of the region are lost — they do NOT enter
 * the terminal's scrollback buffer. That breaks the "scroll up to re-read
 * the conversation" UX that users expect from a shell-like REPL. So we
 * use the inline-redraw pattern instead:
 *
 *   1. Track how many physical rows the live area currently occupies, and
 *      the column of the last partial stream line.
 *   2. Before any stream write: move cursor up over the live area, back to
 *      where the previous stream output left off, and erase from there to
 *      the end of the screen.
 *   3. Write the stream chunk. The terminal scrolls naturally into
 *      scrollback as the cursor descends past the bottom row.
 *   4. Redraw the live area immediately below the new stream cursor.
 *
 * Only relative cursor moves (`ESC[A`, `\r`, `ESC[C`) are used, never
 * absolute positioning, so the math stays correct even when the viewport
 * scrolls in the middle of a write.
 *
 * On non-TTY outputs (pipes, tests with `isTTY=false`) the compositor is
 * a pass-through: `writeStream` writes verbatim, the live area is dropped.
 *
 * @module ui/compositor
 */

import { AnsiStreamBuffer } from "../ansi-stream.ts"
import { cursorVisualCol, displayWidth } from "../term-width.ts"

export interface CompositorOutput {
  write(s: string): boolean | void
  columns?: number
  rows?: number
  isTTY?: boolean
}

export interface CompositorOptions {
  output?: CompositorOutput
  /**
   * If true, wrap each atomic redraw batch (writeBufferedStream and
   * setLiveArea) in DEC mode 2026 Begin/End Synchronized Update markers
   * so the terminal applies the whole frame at once, eliminating
   * visible flicker / scroll-jump during the
   * eraseLiveSeq → writeStream → drawLiveSeq sequence. Detection is
   * the caller's responsibility — see `src/ui/term-caps.ts`. Default
   * false (safe for all terminals; the frame will still be correct,
   * just visibly assembled in steps on a slow paint).
   */
  syncOutput?: boolean
}

export class Compositor {
  private readonly output: CompositorOutput
  private readonly tty: boolean
  private readonly syncOutput: boolean
  private mounted = false

  /** Visible col where the next stream char will be written (0 = line start). */
  private streamCol = 0
  /** Holds trailing partial ANSI escapes so redraw bytes never split them. */
  private readonly streamAnsi = new AnsiStreamBuffer()
  /**
   * Count of consecutive `\n` characters at the tail of the scrollback
   * stream so far. Used to cap blank-line runs at one (i.e. at most two
   * consecutive `\n`) so transient state — model emitting whitespace-only
   * text between tool calls, formatter trailing-newline accumulation,
   * separator `\n` written at sink boundaries — can never compound into
   * 3+ blank rows in scrollback. ANSI escape sequences are zero-width and
   * neither increment nor reset this counter; CR is also passed through
   * (it doesn't open a new line). Reset on unmount.
   */
  private consecutiveNewlines = 0
  /** Number of physical rows the currently-drawn live area occupies. */
  private liveHeightValue = 0
  /** Cursor row inside the live area, 0..liveHeightValue-1. */
  private cursorRowInLive = 0
  private lastLines: string[] = []
  private lastCursor: { row: number; col: number } | null = null

  constructor(opts: CompositorOptions = {}) {
    this.output = opts.output ?? (process.stdout as CompositorOutput)
    this.tty = this.output.isTTY === true
    this.syncOutput = opts.syncOutput === true
  }

  /**
   * BSU/ESU markers (DEC mode 2026, "Synchronized Output").
   * Empty strings when {@link syncOutput} is disabled, so callers can
   * unconditionally `bsu + payload + esu` without an `if` per frame.
   */
  private get bsu(): string {
    return this.syncOutput ? "\x1b[?2026h" : ""
  }
  private get esu(): string {
    return this.syncOutput ? "\x1b[?2026l" : ""
  }

  get liveHeight(): number {
    return this.liveHeightValue
  }

  mount(_initialLiveHeight = 0): void {
    if (this.mounted) return
    this.mounted = true
    if (!this.tty) return
    // Hide cursor while we redraw, the editor will reveal it via setLiveArea.
    this.output.write("\x1b[?25l")
  }

  unmount(): void {
    if (!this.mounted) return
    this.flushStream()
    this.mounted = false
    if (!this.tty) return
    // Move the terminal cursor below the live area so anything the caller
    // prints next (e.g. "Goodbye.") lands on a fresh line beneath it,
    // preserving the final state of the prompt in scrollback.
    const parts: string[] = []
    if (this.liveHeightValue > 0) {
      const downRows = this.liveHeightValue - 1 - this.cursorRowInLive
      if (downRows > 0) parts.push(`\x1b[${downRows}B`)
      parts.push("\r\n")
    }
    parts.push("\x1b[?25h")
    this.output.write(parts.join(""))
    this.liveHeightValue = 0
    this.cursorRowInLive = 0
    this.streamCol = 0
    this.consecutiveNewlines = 0
    this.lastLines = []
    this.lastCursor = null
  }

  writeStream(chunk: string): void {
    if (chunk.length === 0) return
    if (!this.tty) {
      this.output.write(chunk)
      return
    }
    if (!this.mounted) {
      this.output.write(chunk)
      return
    }
    const safeChunk = this.streamAnsi.push(chunk)
    if (safeChunk.length === 0) return
    const capped = this.capBlankLines(safeChunk)
    if (capped.length === 0) return
    this.writeBufferedStream(capped)
  }

  flushStream(): void {
    const tail = this.streamAnsi.flush()
    if (tail.length === 0) return
    if (!this.tty || !this.mounted) {
      this.output.write(tail)
      return
    }
    const capped = this.capBlankLines(tail)
    if (capped.length === 0) return
    this.writeBufferedStream(capped)
  }

  /**
   * Cap consecutive `\n` runs in scrollback output to at most two (= one
   * blank line). Walks `chunk` left-to-right, treating ANSI escape
   * sequences (CSI `ESC [ ... <0x40-0x7E>` and OSC `ESC ] ... BEL|ESC \\`)
   * as zero-width passthrough that does not change `consecutiveNewlines`,
   * and CR as a column-reset that also doesn't change the run. Any `\n`
   * past the second consecutive one is dropped from the output. State
   * persists across calls, so a trailing run can extend an earlier one
   * (a chunk ending in `\n` followed by a chunk starting with `\n\n`
   * sees the second \n as the third in the run and drops it).
   */
  private capBlankLines(chunk: string): string {
    if (chunk.length === 0) return chunk
    const n = chunk.length
    let out = ""
    let i = 0
    while (i < n) {
      const ch = chunk[i]
      if (ch === "\x1b") {
        // ANSI escape — pass through verbatim, zero-width.
        let j = i + 1
        const next = j < n ? chunk[j] : ""
        if (next === "[") {
          j++
          while (j < n) {
            const cc = chunk.charCodeAt(j)
            if (cc >= 0x40 && cc <= 0x7e) {
              j++
              break
            }
            j++
          }
        } else if (next === "]") {
          j++
          while (j < n) {
            if (chunk[j] === "\x07") {
              j++
              break
            }
            if (chunk[j] === "\x1b" && j + 1 < n && chunk[j + 1] === "\\") {
              j += 2
              break
            }
            j++
          }
        } else {
          // Single-char ESC sequence (e.g. ESC =, ESC >, ESC M).
          j = Math.min(j + 1, n)
        }
        out += chunk.slice(i, j)
        i = j
      } else if (ch === "\n") {
        if (this.consecutiveNewlines < 2) out += "\n"
        this.consecutiveNewlines++
        i++
      } else if (ch === "\r") {
        // CR doesn't open a new line; pass through, leave the run intact.
        out += "\r"
        i++
      } else {
        out += ch
        this.consecutiveNewlines = 0
        i++
      }
    }
    return out
  }

  private writeBufferedStream(chunk: string): void {
    const parts: string[] = []
    // BSU before any cursor moves so the terminal buffers the whole
    // erase→write→redraw sequence and presents it as a single frame.
    parts.push(this.bsu)
    parts.push("\x1b[?25l")
    parts.push(this.eraseLiveSeq())
    parts.push(chunk)
    this.streamCol = updateStreamColAfterRedraw(chunk, this.streamCol, this.output.columns)
    parts.push(this.drawLiveSeq())
    parts.push(this.esu)
    this.output.write(parts.join(""))
  }

  setLiveArea(lines: string[], cursor: { row: number; col: number } | null): void {
    this.lastLines = [...lines]
    this.lastCursor = cursor ? { ...cursor } : null
    if (!this.tty || !this.mounted) return
    const parts: string[] = []
    parts.push(this.bsu)
    parts.push("\x1b[?25l")
    parts.push(this.eraseLiveSeq())
    parts.push(this.drawLiveSeq())
    parts.push(this.esu)
    this.output.write(parts.join(""))
  }

  /**
   * Kept for source compatibility with earlier API; height is now derived
   * from the lines array passed to {@link setLiveArea}, so this is a no-op.
   */
  setLiveHeight(_n: number): void {
    /* no-op */
  }

  async withSuspendedLiveArea<T>(fn: () => T | Promise<T>): Promise<T> {
    if (!this.tty || !this.mounted) return await fn()
    // Erase the live area and show the cursor so the callback owns the tty.
    this.output.write(this.bsu + this.eraseLiveSeq() + "\x1b[?25h" + this.esu)
    try {
      return await fn()
    } finally {
      this.streamCol = 0 // assume callback left a clean line
      this.output.write(this.bsu + "\x1b[?25l" + this.drawLiveSeq() + this.esu)
    }
  }

  /**
   * Hook for SIGWINCH.
   *
   * On resize the terminal reflows any wrapped content in the live area
   * to the new width, and our `cursorRowInLive` / `liveHeightValue` /
   * `streamCol` counters — which were measured under the *old* width —
   * become fiction. The next repaint's `eraseLiveSeq()` would then step
   * up by a stale row count, leaving reflowed old content above the
   * erase point. `drawLiveSeq()` paints the new live area below it,
   * producing duplicate prompt lines on screen.
   *
   * Fix: full viewport wipe (`\x1b[H` home + `\x1b[J` erase to end of
   * screen) and invalidate the counters. The very next `setLiveArea()`
   * call (from `editor.notifyResize()` in `src/index.ts:991-992`, which
   * runs synchronously right after this) sees `liveHeightValue === 0`,
   * short-circuits the erase, and paints fresh at the home position.
   *
   * Why not the cheaper `\r\x1b[J`? Because the cursor usually sits on
   * the LAST row of the live area (the prompt). `\r\x1b[J` only clears
   * from that row down, leaving reflowed *upper* portions of the old
   * live area — including any status row and the wrapped early portion
   * of the prompt — visible above the cursor. Then `drawLiveSeq` paints
   * a fresh complete live area starting at that cursor row, putting the
   * new status+prompt directly below the ghost old status+prompt:
   * exactly the duplication the user reported.
   *
   * Trade-off: on-screen transcript flashes off on resize (it survives
   * in scrollback above the viewport). Acceptable because resize is
   * rare and a duplicate prompt is much worse than a transcript that
   * scrolled up by one viewport.
   */
  notifyResize(): void {
    if (!this.tty || !this.mounted) return
    this.output.write(this.bsu + "\x1b[H\x1b[J" + this.esu)
    this.liveHeightValue = 0
    this.cursorRowInLive = 0
    this.streamCol = 0
  }

  // ------------------------- internal sequences -------------------------

  private eraseLiveSeq(): string {
    if (this.liveHeightValue === 0) {
      // No live area drawn yet; nothing to erase. Cursor is at the natural
      // stream position already.
      return ""
    }
    const parts: string[] = []
    // Move from editor cursor row up to top of live area, col 0.
    if (this.cursorRowInLive > 0) {
      parts.push(`\x1b[${this.cursorRowInLive}A`)
    }
    parts.push("\r")
    // If the previous stream chunk ended mid-line, we wrote `\r\n` before
    // drawing the live area; undo that by stepping up one row and forward
    // to the saved column.
    if (this.streamCol > 0) {
      parts.push("\x1b[1A")
      parts.push(`\x1b[${this.streamCol}C`)
    }
    // Erase from cursor to end of screen — wipes the live area (and any
    // trailing characters past streamCol on the current row, which is
    // fine because nothing should be there).
    parts.push("\x1b[J")
    this.liveHeightValue = 0
    this.cursorRowInLive = 0
    return parts.join("")
  }

  private drawLiveSeq(): string {
    const lines = this.lastLines
    const cursor = this.lastCursor
    if (lines.length === 0) {
      // Nothing to draw, just settle cursor visibility.
      return cursor ? "\x1b[?25h" : "\x1b[?25l"
    }
    const parts: string[] = []
    // Live area must start at column 0 of a fresh line. If the stream
    // cursor is mid-line, write CRLF first so the live area doesn't
    // collide with stream content.
    if (this.streamCol > 0) {
      parts.push("\r\n")
    }
    for (let i = 0; i < lines.length; i++) {
      parts.push(lines[i])
      // Clear to end of line in case the previous content here was wider.
      parts.push("\x1b[K")
      if (i < lines.length - 1) parts.push("\r\n")
    }
    // Cursor is now at the end of the last live-area line.
    const lastIdx = lines.length - 1
    if (cursor) {
      const rowsUp = lastIdx - cursor.row
      if (rowsUp > 0) parts.push(`\x1b[${rowsUp}A`)
      parts.push("\r")
      if (cursor.col > 0) parts.push(`\x1b[${cursor.col}C`)
      this.cursorRowInLive = cursor.row
      parts.push("\x1b[?25h")
    } else {
      this.cursorRowInLive = lastIdx
      parts.push("\x1b[?25l")
    }
    this.liveHeightValue = lines.length
    return parts.join("")
  }
}

/**
 * Update the running "visible column on the current partial stream line"
 * after writing `chunk`. Newlines (LF or CR) reset to column 0; ANSI
 * escapes contribute no width.
 *
 * Width is measured in **display cells** via {@link displayWidth}, so
 * wide East-Asian glyphs and emoji count as 2 cells, combining marks as
 * 0. This matters because `eraseLiveSeq` walks the cursor back to
 * `streamCol` to reposition at the end of the partial stream line; if
 * `streamCol` underestimates by 1 per wide char, the cursor lands
 * mid-glyph and `\x1b[J` erases the wrong region.
 *
 * Note: full grapheme clustering (flag emoji, complex ZWJ sequences) is
 * not implemented; callers may still drift on those — see the comment
 * in `term-width.ts`.
 */
export function updateStreamCol(chunk: string, prevCol: number, columns?: number): number {
  const lastNl = Math.max(chunk.lastIndexOf("\n"), chunk.lastIndexOf("\r"))
  const normalize = (width: number) => {
    if (typeof columns !== "number" || columns <= 0) return width
    return cursorVisualCol(0, width, columns)
  }
  if (lastNl === -1) {
    return normalize(prevCol + displayWidth(chunk))
  }
  // Everything after the last newline is the new partial line.
  return normalize(displayWidth(chunk.slice(lastNl + 1)))
}

function updateStreamColAfterRedraw(chunk: string, prevCol: number, columns?: number): number {
  const suffix = suffixAfterLastRedrawClear(chunk)
  if (suffix === null) return updateStreamCol(chunk, prevCol, columns)
  return updateStreamCol(suffix, 0, columns)
}

function suffixAfterLastRedrawClear(chunk: string): string | null {
  let end = -1
  const redraw = /\x1b\[\d*A\r\x1b\[(?:0)?J|\r\x1b\[(?:0)?J/g
  for (const match of chunk.matchAll(redraw)) {
    end = (match.index ?? 0) + match[0].length
  }
  return end === -1 ? null : chunk.slice(end)
}

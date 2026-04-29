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
}

export class Compositor {
  private readonly output: CompositorOutput
  private readonly tty: boolean
  private mounted = false

  /** Visible col where the next stream char will be written (0 = line start). */
  private streamCol = 0
  /** Holds trailing partial ANSI escapes so redraw bytes never split them. */
  private readonly streamAnsi = new AnsiStreamBuffer()
  /** Number of physical rows the currently-drawn live area occupies. */
  private liveHeightValue = 0
  /** Cursor row inside the live area, 0..liveHeightValue-1. */
  private cursorRowInLive = 0
  private lastLines: string[] = []
  private lastCursor: { row: number; col: number } | null = null

  constructor(opts: CompositorOptions = {}) {
    this.output = opts.output ?? (process.stdout as CompositorOutput)
    this.tty = this.output.isTTY === true
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
    this.writeBufferedStream(safeChunk)
  }

  flushStream(): void {
    const tail = this.streamAnsi.flush()
    if (tail.length === 0) return
    if (!this.tty || !this.mounted) {
      this.output.write(tail)
      return
    }
    this.writeBufferedStream(tail)
  }

  private writeBufferedStream(chunk: string): void {
    const parts: string[] = []
    parts.push("\x1b[?25l")
    parts.push(this.eraseLiveSeq())
    parts.push(chunk)
    this.streamCol = updateStreamCol(chunk, this.streamCol, this.output.columns)
    parts.push(this.drawLiveSeq())
    this.output.write(parts.join(""))
  }

  setLiveArea(lines: string[], cursor: { row: number; col: number } | null): void {
    this.lastLines = [...lines]
    this.lastCursor = cursor ? { ...cursor } : null
    if (!this.tty || !this.mounted) return
    const parts: string[] = []
    parts.push("\x1b[?25l")
    parts.push(this.eraseLiveSeq())
    parts.push(this.drawLiveSeq())
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
    this.output.write(this.eraseLiveSeq() + "\x1b[?25h")
    try {
      return await fn()
    } finally {
      this.streamCol = 0 // assume callback left a clean line
      this.output.write("\x1b[?25l" + this.drawLiveSeq())
    }
  }

  /**
   * Hook for SIGWINCH. With the inline-redraw model there's no scroll
   * region to recompute — the live area will reflow on the next repaint.
   * Provided for API symmetry with the previous DECSTBM-based design.
   */
  notifyResize(): void {
    /* no-op */
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
    // The live area is preceded by a blank separator line (drawn by
    // drawLiveSeq for visual breathing room between scrollback and the
    // live area). Step up over it.
    parts.push("\x1b[1A")
    // If the previous stream chunk ended mid-line, we wrote `\r\n` before
    // drawing the blank separator; undo that by stepping up one more row
    // and forward to the saved column.
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
    // collide with stream content. Then emit one extra CRLF to leave a
    // blank separator line between the last scrollback content and the
    // top of the live area, for visual consistency with the gap between
    // streamed tool blocks.
    if (this.streamCol > 0) {
      parts.push("\r\n")
    }
    parts.push("\r\n")
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

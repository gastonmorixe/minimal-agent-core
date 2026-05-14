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
  /**
   * Whether `drawLiveSeq` already emitted its blank-row separator above
   * the current live area. Reset on every `writeBufferedStream` (new
   * scrollback content invalidates the prior separator's position) and
   * on `unmount`/`notifyResize` (live area state cleared).
   *
   * Without this flag, repeated draw cycles (typing, status changes)
   * would each add a fresh separator row → the live area would drift
   * down by one row per repaint.
   */
  private liveSepDrawn = false
  /**
   * Rows of `\r\n` that `drawLiveSeq` emitted between the previous
   * scrollback content and the start of the live area: 0 (no forced
   * \r\n, no separator), 1 (one of: forced-CRLF for mid-line OR the
   * smart-skip separator), or 2 (both). `eraseLiveSeq` walks the
   * cursor back UP over this many rows so the next chunk write lands
   * at the original scrollback cursor position, not on a separator
   * row that would then be overwritten.
   */
  private sepRowsAboveLive = 0
  /**
   * Effective columns at which the current live area / streamCol counters
   * were measured. When the next paint observes a different value, the
   * stale counters (and any in-terminal wrapping under the old width) will
   * desynchronize from physical reality: `eraseLiveSeq`'s `\x1b[<n>A`
   * walks back by logical-row count, but content that wrapped at the OLD
   * cols occupies more physical rows than the counter knows, so the erase
   * undershoots and the stale top of the live area scrolls into scrollback.
   *
   * This is the same failure mode SIGWINCH triggers, but cols can change
   * silently — `script(1)` PTY-size-propagation jitter, a SIGWINCH that
   * landed between repaints but before `editor.notifyResize()`, or a
   * tty whose TIOCGWINSZ reports a different value than what was current
   * when we last drew. Detecting it at paint time and replaying the
   * resize-recovery wipe gives the next draw a clean slate.
   *
   * 0 means "no live area drawn yet, no baseline to compare against".
   */
  private lastDrawColumns = 0
  private lastLines: string[] = []
  private lastCursor: { row: number; col: number } | null = null
  private drawnLiveKey: string | null = null

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
    this.liveSepDrawn = false
    this.sepRowsAboveLive = 0
    this.lastDrawColumns = 0
    this.lastLines = []
    this.lastCursor = null
    this.drawnLiveKey = null
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
        // Cap consecutive `\n` runs at 3 (= 2 blank rows max in scrollback).
        // Bumped from `< 2` (1 blank max) to `< 3` (2 blanks max) so
        // turn-end transitions can land 2 blank rows above a freshly
        // committed prompt — `EditorController.submit` emits 3 leading
        // `\n`s and relies on this cap to absorb whatever the previous
        // content left in the run.
        if (this.consecutiveNewlines < 3) out += "\n"
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
    // Same cols-drift recovery setLiveArea does — without it, a scrollback
    // chunk written under a stale-cols live area would push the live area's
    // wrapped-but-uncounted top rows into permanent scrollback.
    this.maybeRecoverFromColsDrift()
    const parts: string[] = []
    // BSU before any cursor moves so the terminal buffers the whole
    // erase→write→redraw sequence and presents it as a single frame.
    parts.push(this.bsu)
    parts.push("\x1b[?25l")
    parts.push(this.eraseLiveSeq())
    parts.push(chunk)
    this.streamCol = updateStreamColAfterRedraw(chunk, this.streamCol, this.effectiveColumns())
    // New scrollback content was just appended — the prior live-area
    // separator (if any) is now buried mid-scrollback. Reset so the next
    // `drawLiveSeq` decides afresh whether to draw a separator.
    this.liveSepDrawn = false
    parts.push(this.drawLiveSeq())
    parts.push(this.esu)
    this.output.write(parts.join(""))
    this.lastDrawColumns = this.effectiveColumns()
    this.drawnLiveKey = liveAreaKey(this.lastLines, this.lastCursor)
  }

  /**
   * Effective terminal width for the partial-redraw modulo math.
   *
   * `process.stdout.columns` is `0` when the host's TTY reports
   * `WINSZ=0` — most commonly when the agent runs under macOS BSD
   * `script(1)`, which allocates a slave PTY but never propagates
   * the parent terminal's window size. With `columns ≤ 0`,
   * `updateStreamCol` skips the wrap-modulo and returns the raw
   * cell count of the partial line; `eraseLiveSeq` then emits
   * `\x1b[1A\x1b[<raw>C\x1b[J`, which on a real terminal that *is*
   * narrower clamps to the right edge and lands the cursor on the
   * wrong physical row, leaving the first wrap row of the partial
   * stuck in scrollback above the eventual rendered version
   * (visible as a duplicated paragraph in script-recorded sessions).
   *
   * Fall back to `$COLUMNS` so users recording sessions can opt in
   * with `COLUMNS=N script -r out.log -- bun run minimal-agent`.
   * mdstream already does the same (renderer.rs `term_width`),
   * so this brings the two layers into agreement.
   */
  private effectiveColumns(): number {
    const c = this.output.columns ?? 0
    if (c > 0) return c
    const env = Number.parseInt(process.env.COLUMNS ?? "", 10)
    return Number.isFinite(env) && env > 0 ? env : 0
  }

  setLiveArea(lines: string[], cursor: { row: number; col: number } | null): void {
    const nextLines = [...lines]
    const nextCursor = cursor ? { ...cursor } : null
    const nextKey = liveAreaKey(nextLines, nextCursor)
    this.lastLines = nextLines
    this.lastCursor = nextCursor
    if (!this.tty || !this.mounted) return
    if (this.liveHeightValue > 0 && this.drawnLiveKey === nextKey && !this.hasColsDrift()) return
    // Detect silent cols changes (PTY-size jitter, SIGWINCH that hasn't
    // hit `editor.notifyResize()` yet, terminals whose TIOCGWINSZ races
    // with their actual width). The recovery wipes the viewport and
    // zeroes our counters so `drawLiveSeq` starts at home with no stale
    // wrapped content lurking above the new draw.
    this.maybeRecoverFromColsDrift()
    const repaintExistingLiveArea = this.liveHeightValue > 0
    const parts: string[] = []
    parts.push(this.bsu)
    parts.push("\x1b[?25l")
    parts.push(this.eraseLiveSeq({ includeSepRows: !repaintExistingLiveArea }))
    parts.push(this.drawLiveSeq({ reuseExistingGap: repaintExistingLiveArea }))
    parts.push(this.esu)
    this.output.write(parts.join(""))
    this.lastDrawColumns = this.effectiveColumns()
    this.drawnLiveKey = nextKey
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
      this.drawnLiveKey = liveAreaKey(this.lastLines, this.lastCursor)
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
   * Fix: full viewport wipe with `\x1b[H\x1b[J` and zero the counters.
   * The next `setLiveArea()` call (from `editor.notifyResize()` in
   * `src/index.ts`, which runs synchronously right after this) sees
   * `liveHeightValue === 0` and paints the new live area at the home
   * position (top-left).
   *
   * Why not preserve stream content into scrollback first? Two previous
   * attempts went down this road and both backfired:
   *
   *   - 5b36689 emitted `\x1b[<rows>B + \n × rows` (scroll the entire
   *     viewport into scrollback before wiping). Problem: this also
   *     committed the live area (status + editor + footer) to scrollback
   *     on every resize. After a few resizes the user saw N duplicate
   *     prompt blocks piled up in their history.
   *
   *   - 4e7c0fd narrowed the scroll to `\n × (rows - liveHeight)`,
   *     trying to push only stream-content rows above the live area.
   *     But this assumes the live area is sticky-to-bottom of the
   *     viewport. In real sessions the live area can sit anywhere
   *     vertically (after a turn ends with blank rows below it, after
   *     a short response, when the screen isn't full, etc.). When the
   *     live area is NOT at the bottom, the LFs scroll some of the
   *     blank-below-it rows out AND some of the live area itself in,
   *     producing the same N-duplicates-in-scrollback bug.
   *
   * The bare wipe trades one bug for another: on iTerm (and other
   * terminals that drop `\x1b[J`-erased cells from scrollback history),
   * the most recent ~viewport-rows of in-flight stream content can be
   * lost if a resize fires mid-stream before those rows naturally
   * scrolled into scrollback. But: (a) most stream content reaches
   * scrollback via `\n`-at-bottom scrolling during normal write flow,
   * so only the bottom-of-viewport tail is at risk; (b) the assistant's
   * response is persisted in the session JSONL so nothing is truly
   * lost: at worst the user re-runs `--resume`. The duplicate-prompt
   * pileup is much more user-visible and was the original symptom that
   * surfaced this whole bug cluster.
   *
   * Regression history:
   * - Originally a bare `\x1b[H\x1b[J` (the current behavior).
   * - 5b36689 introduced LF×rows preamble (live-area-duplication bug).
   * - 86d2d3b accidentally reverted 5b36689 while refactoring blank-
   *   line invariants.
   * - 4e7c0fd reapplied 5b36689's idea AND attempted to narrow the
   *   scroll to only stream content. Both attempts misbehaved when
   *   the live area was not sticky-to-bottom.
   * - This change reverts to the bare wipe and documents WHY the
   *   preserve-scrollback attempts can't be made reliable without
   *   absolute cursor positioning (which requires DSR roundtrip).
   */
  notifyResize(): void {
    if (!this.tty || !this.mounted) return
    this.output.write(this.bsu + "\x1b[H\x1b[J" + this.esu)
    this.resetLiveCounters()
  }

  /**
   * Zero every counter that tracks where the live area is on screen.
   * Used by `notifyResize` and by the paint-time cols-drift recovery
   * in `setLiveArea` / `writeBufferedStream`.
   */
  private resetLiveCounters(): void {
    this.liveHeightValue = 0
    this.cursorRowInLive = 0
    this.streamCol = 0
    this.liveSepDrawn = false
    this.sepRowsAboveLive = 0
    this.lastDrawColumns = 0
    this.drawnLiveKey = null
  }

  /**
   * If `effectiveColumns()` has changed since the last successful draw,
   * the in-screen state is fiction (see `lastDrawColumns` doc). Same
   * recovery as `notifyResize`: full viewport wipe with `\x1b[H\x1b[J`
   * and zero counters.
   *
   * Returns `true` when recovery fired.
   *
   * No-op when there is no live area yet (`lastDrawColumns === 0`) or
   * when cols hasn't moved. Also no-op when the terminal is detached.
   */
  private maybeRecoverFromColsDrift(): boolean {
    if (!this.hasColsDrift()) return false
    this.output.write(this.bsu + "\x1b[H\x1b[J" + this.esu)
    this.resetLiveCounters()
    return true
  }

  private hasColsDrift(): boolean {
    if (!this.tty || !this.mounted) return false
    if (this.lastDrawColumns === 0) return false
    const now = this.effectiveColumns()
    // `effectiveColumns()` returns 0 only when both `output.columns` and
    // `$COLUMNS` are unavailable; in that case we have no signal to act
    // on, so leave the counters alone.
    return now !== 0 && now !== this.lastDrawColumns
  }

  // ------------------------- internal sequences -------------------------

  private eraseLiveSeq(opts: { includeSepRows?: boolean } = {}): string {
    if (this.liveHeightValue === 0) {
      // No live area drawn yet; nothing to erase. Cursor is at the natural
      // stream position already.
      return ""
    }
    const includeSepRows = opts.includeSepRows !== false
    const parts: string[] = []
    // Move from editor cursor row up to top of live area, col 0.
    if (this.cursorRowInLive > 0) {
      parts.push(`\x1b[${this.cursorRowInLive}A`)
    }
    parts.push("\r")
    // Stream writes must walk back over any rows that `drawLiveSeq`
    // emitted above the live area. Pure live-area repaints stay on the
    // live area's first row so the prompt does not move into the gap.
    if (includeSepRows && this.sepRowsAboveLive > 0) {
      parts.push(`\x1b[${this.sepRowsAboveLive}A`)
    }
    // The walk-right-by-streamCol step is part of "land back at the
    // original scrollback cursor" and only makes sense in tandem with
    // the walk-up over sep rows. Pure live-area repaints (spinner blink,
    // editor keystrokes) stay on the live area's top row and must NOT
    // shift right — otherwise the new content lands at col streamCol of
    // the status row instead of col 0, leaving the previous label
    // visible at cols 0..streamCol-1 (visible as horizontally
    // accumulating "● Thinking … Thinking … ● Thinking …" on every
    // blink while streamCol grows with the response).
    if (includeSepRows && this.streamCol > 0) {
      parts.push(`\x1b[${this.streamCol}C`)
    }
    // Erase from cursor to end of screen. For stream writes, this also
    // erases separator rows above the live area.
    parts.push("\x1b[J")
    this.liveHeightValue = 0
    this.cursorRowInLive = 0
    this.drawnLiveKey = null
    if (includeSepRows) this.sepRowsAboveLive = 0
    return parts.join("")
  }

  private drawLiveSeq(opts: { reuseExistingGap?: boolean } = {}): string {
    const lines = this.lastLines
    const cursor = this.lastCursor
    if (lines.length === 0) {
      // Nothing to draw, just settle cursor visibility.
      return cursor ? "\x1b[?25h" : "\x1b[?25l"
    }
    const parts: string[] = []
    const reuseExistingGap = opts.reuseExistingGap === true && this.liveSepDrawn
    let sepConsumed = reuseExistingGap ? this.sepRowsAboveLive : 0
    if (!reuseExistingGap) {
      // Live area must start at column 0 of a fresh line. If the stream
      // cursor is mid-line, write CRLF first so the live area doesn't
      // collide with stream content.
      sepConsumed = 0 // count of \r\n we emit for separator/forced
      if (this.streamCol > 0) {
        parts.push("\r\n")
        sepConsumed++
      }
      // Smart-skip blank separator above the live area. Goal: exactly one
      // visible blank row between scrollback content and the live area's
      // first row. Skip when scrollback already ends with a blank row
      // (consecutiveNewlines >= 2 → one or more blanks already emitted).
      // The mid-line `\r\n` above counts as the row terminator only — it
      // doesn't itself create a blank — so when streamCol > 0 we still
      // need the separator.
      const alreadyBlank = this.streamCol === 0 && this.consecutiveNewlines >= 2
      if (!this.liveSepDrawn && !alreadyBlank) {
        parts.push("\r\n")
        sepConsumed++
      }
      this.liveSepDrawn = true
    }
    this.sepRowsAboveLive = sepConsumed
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

function liveAreaKey(lines: string[], cursor: { row: number; col: number } | null): string {
  return JSON.stringify([lines, cursor])
}

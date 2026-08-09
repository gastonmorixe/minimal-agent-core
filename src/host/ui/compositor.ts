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

import { cursorVisualCol, displayWidth } from "../../terminal/term-width.ts"

import { AnsiStreamBuffer } from "./terminal/ansi-stream.ts"

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

/**
 * Owner of the terminal's bottom "live area" (editor, status row, footer)
 * coexisting with normal scrollback output. Every scrollback write goes
 * through erase-live, then write, then redraw-live so the live region never
 * interleaves with streamed text; it also normalizes blank-line runs,
 * buffers partial ANSI escapes across writes, and can wrap frames in DEC
 * 2026 synchronized-update markers to eliminate flicker.
 */
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
   * `\r\n`, no separator), 1 (one of: forced-CRLF for mid-line OR the
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
  /**
   * When true, `writeStream` / `writeBufferedStream` append into
   * {@link heldStream} instead of erasing and redrawing the live area.
   * Armed by {@link notifyResize} / {@link beginStreamHold} for the
   * duration of a window-edge drag; released by the next
   * {@link setLiveArea} (the editor's trailing coalesced repaint) which
   * flushes the held bytes as one stream write at final geometry.
   * Without this, every model/mdstream chunk during "Receiving stream"
   * would still paint intermediate-width live frames mid-drag even after
   * editor `repaint()` suppression (MA-481485).
   */
  private streamHold = false
  /** Stream bytes held while {@link streamHold} is true. */
  private heldStream = ""

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
    // Drop any resize-hold so flushStream / teardown can write freely.
    this.streamHold = false
    const held = this.heldStream
    this.heldStream = ""
    if (held.length > 0) this.writeBufferedStream(held)
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
    // Raw mode (REPL stdin) clears ONLCR: bare LF advances the row but
    // keeps the column. Formatters like mdstream emit LF-only line
    // endings, so fence bodies/borders paint mid-line unless we normalize.
    if (!this.mounted) {
      this.output.write(normalizeLfToCrlf(chunk))
      return
    }
    const safeChunk = this.streamAnsi.push(chunk)
    if (safeChunk.length === 0) return
    const capped = this.capBlankLines(safeChunk)
    if (capped.length === 0) return
    const forTty = normalizeLfToCrlf(capped)
    if (this.streamHold) {
      this.heldStream += forTty
      return
    }
    this.writeBufferedStream(forTty)
  }

  flushStream(): void {
    const tail = this.streamAnsi.flush()
    if (tail.length === 0) return
    if (!this.tty) {
      this.output.write(tail)
      return
    }
    if (!this.mounted) {
      this.output.write(normalizeLfToCrlf(tail))
      return
    }
    const capped = this.capBlankLines(tail)
    if (capped.length === 0) return
    const forTty = normalizeLfToCrlf(capped)
    if (this.streamHold) {
      this.heldStream += forTty
      return
    }
    this.writeBufferedStream(forTty)
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
   * sees the second `\n` as the third in the run and drops it).
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
    // Snapshot the PREVIOUSLY-drawn lines/cursor BEFORE overwriting
    // `lastLines`/`lastCursor`. `eraseLiveSeq` needs them to re-measure
    // the physical-row span of the still-on-screen live area under the
    // CURRENT cols — which may be smaller than `lastDrawColumns`, in
    // which case lines that exceeded the new cols have wrapped on the
    // terminal side, putting the cursor at a lower physical row than
    // the stored logical `cursorRowInLive`. Walking up by the stale
    // logical count would leave the top of the reflowed live area
    // unerased (orphan), which subsequent `writeBufferedStream` calls
    // scroll into permanent scrollback as duplicated status / editor
    // rows. The fallback in `eraseLiveSeq` reads `this.lastLines`/
    // `this.lastCursor`, which is correct for `writeBufferedStream` /
    // `withSuspendedLiveArea` (they don't reassign), but NOT for the
    // `setLiveArea` path — hence the explicit hand-off here.
    const prevLines = this.lastLines
    const prevCursor = this.lastCursor
    const nextLines = [...lines]
    const nextCursor = cursor ? { ...cursor } : null
    const nextKey = liveAreaKey(nextLines, nextCursor)
    this.lastLines = nextLines
    this.lastCursor = nextCursor
    if (!this.tty || !this.mounted) {
      // Still clear a hold so a later mount doesn't flush stale bytes.
      this.streamHold = false
      this.heldStream = ""
      return
    }
    // Take held stream under the resize coalesce. Prefer ONE frame:
    // erase old live → write held chunk → draw newest live (MA-481485).
    // Calling writeBufferedStream first would paint lastLines (already
    // overwritten to next) then paint again below = two redraws.
    const heldPending = this.heldStream
    this.heldStream = ""
    this.streamHold = false
    const hasHeld = heldPending.length > 0
    if (
      !hasHeld &&
      this.liveHeightValue > 0 &&
      this.drawnLiveKey === nextKey &&
      !this.hasColsDrift()
    ) {
      return
    }
    // Detect silent cols changes (PTY-size jitter, SIGWINCH that hasn't
    // hit `editor.notifyResize()` yet, terminals whose TIOCGWINSZ races
    // with their actual width). The recovery wipes the viewport and
    // zeroes our counters so `drawLiveSeq` starts at home with no stale
    // wrapped content lurking above the new draw.
    this.maybeRecoverFromColsDrift()
    // Held stream must walk over sep rows (includeSepRows true) so the
    // chunk lands at the scrollback cursor. Pure live repaint without
    // held stream keeps the existing-live shortcut.
    const repaintExistingLiveArea = this.liveHeightValue > 0 && !hasHeld
    const parts: string[] = []
    parts.push(this.bsu)
    parts.push("\x1b[?25l")
    parts.push(
      this.eraseLiveSeq({
        includeSepRows: !repaintExistingLiveArea,
        drawnLines: prevLines,
        drawnCursor: prevCursor,
      }),
    )
    if (hasHeld) {
      parts.push(heldPending)
      this.streamCol = updateStreamColAfterRedraw(
        heldPending,
        this.streamCol,
        this.effectiveColumns(),
      )
      // Held stream is new scrollback; prior separator is buried.
      this.liveSepDrawn = false
    }
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
    // Flush any resize-held stream before handing the tty to the callback
    // so held model chunks are not retained across suspend (MA-481485).
    const heldPending = this.heldStream
    this.heldStream = ""
    this.streamHold = false
    // Erase the live area and show the cursor so the callback owns the tty.
    // If we held stream bytes, emit them after erase (same order as
    // setLiveArea's held path) before the callback runs.
    const openParts: string[] = [this.bsu, this.eraseLiveSeq()]
    if (heldPending.length > 0) {
      openParts.push(heldPending)
      this.streamCol = updateStreamColAfterRedraw(
        heldPending,
        this.streamCol,
        this.effectiveColumns(),
      )
      this.liveSepDrawn = false
    }
    openParts.push("\x1b[?25h", this.esu)
    this.output.write(openParts.join(""))
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
   * **HARD RULE: the compositor never touches scrollback.** It owns
   * only the live area (the bottom N rows it last painted under the
   * current cols). On resize, the terminal has already reflowed our
   * cells in place — but our `liveHeightValue` / `cursorRowInLive` /
   * `streamCol` counters were measured under the *old* cols and are
   * now fiction. Any cursor walk-up or erase from us could land
   * outside the live area and damage scrollback.
   *
   * Therefore: **emit nothing**. We forget our row-count tracking
   * (`resetLiveCounters`) and the next paint flows from wherever the
   * cursor currently sits. The reflowed old live area cells survive
   * as inert text in the terminal grid — visible as a "ghost prompt"
   * if the user scrolls, but every byte of prior scrollback is
   * intact.
   *
   * Regression history (and why nothing else works):
   * - Originally `\x1b[H\x1b[J` (full viewport wipe). User-reported
   *   May 2026 session b50c7354: every resize destroys ~viewport-rows
   *   of scrollback on iTerm (which drops `\x1b[J`-erased cells from
   *   history) — neofetch banner truncated, fish welcome gone, agent
   *   banner gone.
   * - 5b36689 tried `\x1b[<rows>B + \n × rows` to preserve scrollback.
   *   Duplicated the live area into history on every resize.
   * - 4e7c0fd tried `\n × (rows - liveHeight)`. Same flaw — assumed
   *   live area is sticky-to-bottom of viewport, which it isn't.
   * - 0461c28 reverted to bare wipe (the bug above).
   * - This change: emit NOTHING on resize. Forget. Append fresh on
   *   next paint. Trade-off: ghost prompt residue is visible above
   *   the new live area until the next stream write scrolls it into
   *   history. User explicitly chose this over scrollback loss.
   *
   * The complementary half of this invariant lives in `eraseLiveSeq`
   * (no `\x1b[J`, uses `\x1b[K` per-row) and `drawLiveSeq` (overwrites
   * shrink residuals with `\r\n\x1b[K`).
   */
  /**
   * Arm stream-hold without emitting CSI. Prefer {@link notifyResize}
   * from SIGWINCH paths; this exists so the editor can arm hold when it
   * only owns the trailing coalesce timer (tests / dual-listener setups).
   */
  beginStreamHold(): void {
    // Only hold when a live area is on screen; otherwise stream writes
    // should pass through (and a dangling hold with no setLiveArea could
    // retain output forever).
    if (!this.tty || !this.mounted || this.liveHeightValue === 0) return
    this.streamHold = true
  }

  notifyResize(): void {
    if (!this.tty || !this.mounted) return
    // Hold stream paints until the editor's trailing setLiveArea so
    // mid-drag model chunks do not erase/redraw the live area at every
    // intermediate column (MA-481485). Emit nothing else (HARD RULE).
    // Only arm when a live area exists (see beginStreamHold).
    if (this.liveHeightValue > 0) this.streamHold = true
    // HARD RULE: emit nothing on SIGWINCH. Do not reset counters.
    //
    // Reasoning: the terminal already reflowed our cells in place. Our
    // `cursorRowInLive` / `liveHeightValue` counters are slightly stale
    // (the live area may now occupy ±1 physical row vs. our logical
    // tracking due to text re-wrapping), but they are still our best
    // estimate of where the live area lives. The next `setLiveArea`
    // call (driven synchronously by `editor.notifyResize()`) will run
    // its normal `eraseLiveSeq` walk-up + `drawLiveSeq` per-row
    // `\x1b[K` overwrite, covering the old live area in place.
    //
    // Why NOT emit `\r\n` or `\x1b[J` or reset counters:
    //  - `\r\n` advances the cursor past the reflowed live area, so
    //    the next draw lands BELOW it. The old cells then scroll up
    //    into scrollback as ghost text — and EVERY subsequent
    //    cols-drift recovery does the same → 6+ stacked `❯` rows
    //    pile up in user-visible scrollback. (User-reported May 2026.)
    //  - `\x1b[J` destroys scrollback on iTerm. (User-reported May
    //    2026 session b50c7354: ~20 rows of neofetch + fish welcome +
    //    agent banner obliterated per resize.)
    //  - Resetting counters drops our walk-up math → `eraseLiveSeq`
    //    becomes a no-op → `drawLiveSeq` starts at current cursor
    //    (end of editor row, col N) → first byte of new "status"
    //    overstrikes the old `❯` → "❯ ❯" cursor duplication.
    //
    // Residue, honestly: on a NARROWING resize the terminal reflows our
    // pre-wrapped full-width live-area lines, growing their physical
    // height. If the live area was near the viewport floor, its TOP rows
    // scroll ABOVE the viewport into permanent scrollback at reflow time —
    // before this handler even runs. The next `setLiveArea`'s relative
    // `eraseLiveSeq` (walk-up + `\x1b[J`) can only reach rows still inside
    // the viewport, so those scrolled-off rows remain as a frozen copy.
    // This is inherent to inline (non-alt-screen) redraw: `\x1b[J` cannot
    // erase above the viewport top, and DEC 2026 sync does not prevent the
    // reflow scroll (fish/zsh/prompt_toolkit hit the same wall — only an
    // alternate-screen full-screen app avoids it).
    //
    // The damaging case was a window-edge DRAG: one SIGWINCH per column ×
    // one residue each = dozens of stacked `❯ … ^ N more lines` copies in
    // scrollback (user-reported May 2026). That accumulation is killed in
    // `EditorController.notifyResize`, which now COALESCES the burst into a
    // single trailing-edge repaint (`resizeDebounceMs`), so a whole drag
    // produces at most one residue instead of one per column. A single
    // deliberate resize may still leave one transient stranded row; that is
    // the accepted inline-mode limit, NOT scrollback loss.
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
   * HARD RULE as `notifyResize`: emit nothing, forget our row-count
   * tracking, let the next paint flow from current cursor.
   *
   * Returns `true` when recovery fired.
   *
   * No-op when there is no live area yet (`lastDrawColumns === 0`) or
   * when cols hasn't moved. Also no-op when the terminal is detached.
   */
  private maybeRecoverFromColsDrift(): boolean {
    if (!this.hasColsDrift()) return false
    // HARD RULE: emit nothing on cols drift. Same reasoning as
    // `notifyResize`. The subsequent `eraseLiveSeq` + `drawLiveSeq`
    // path will redraw with slightly-stale counters but per-row
    // `\x1b[K` overwrites cover the discrepancy. Do not reset
    // counters: that would drop our walk-up math and cause the new
    // draw to start at the wrong cursor position.
    //
    // We still return `true` for signaling purposes (callers may
    // care about the cols transition for other reasons), but the
    // side-effect is now zero output.
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

  private eraseLiveSeq(
    opts: {
      includeSepRows?: boolean
      /**
       * Previously-drawn lines / cursor. Pass explicitly from
       * `setLiveArea` because it overwrites `this.lastLines` /
       * `this.lastCursor` BEFORE calling here.
       * `writeBufferedStream` and `withSuspendedLiveArea` leave those
       * fields intact (they hold the currently-on-screen lines), so
       * they can omit the option and the fallback to `this.lastLines`
       * / `this.lastCursor` is correct for them.
       */
      drawnLines?: string[]
      drawnCursor?: { row: number; col: number } | null
    } = {},
  ): string {
    if (this.liveHeightValue === 0) {
      // No live area drawn yet; nothing to erase. Cursor is at the natural
      // stream position already.
      return ""
    }
    const includeSepRows = opts.includeSepRows !== false
    const drawnLines = opts.drawnLines ?? this.lastLines
    const drawnCursor = opts.drawnCursor !== undefined ? opts.drawnCursor : this.lastCursor
    const parts: string[] = []
    // Move from editor cursor row up to top of live area, col 0.
    //
    // The walk-up MUST count physical rows under CURRENT cols, not the
    // logical `cursorRowInLive` we stored at draw time. Under stable
    // cols the two agree (each drawn line fits in `lastDrawColumns`
    // cells, so logical row count == physical row count). Under cols
    // drift smaller than `lastDrawColumns`, lines whose `displayWidth`
    // now exceeds the new cols have wrapped on the terminal side,
    // pushing the cursor's physical row down — walking up by the
    // logical count leaves the top of the reflowed live area
    // unerased, and subsequent stream chunks scroll those owned rows
    // into permanent scrollback as orphans. (User-reported May 21
    // 2026: duplicated status rows pile into scrollback when typing
    // / waiting for response in a narrowed terminal.)
    const walkUpRows = this.computePhysicalCursorRowInLive(drawnLines, drawnCursor)
    if (walkUpRows > 0) {
      parts.push(`\x1b[${walkUpRows}A`)
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
    // Erase from cursor to end of screen. SAFE under stable cols
    // because the walk-up sequence above lands the cursor strictly
    // inside our owned territory (stream-cursor position above sep rows
    // + live area, OR top of live area on pure repaints). `\x1b[J`
    // erases cells from the cursor DOWN to viewport bottom — scrollback
    // ABOVE the cursor is untouched. This is the load-bearing erase
    // that makes writeBufferedStream + setLiveArea correct.
    //
    // The HARD RULE about "never destroy scrollback" applies to
    // `\x1b[H\x1b[J` (home + clear, used pre-May-2026 by notifyResize),
    // which jumps the cursor to top of viewport before erasing — that
    // form destroys visible scrollback on iTerm. `\x1b[J` from our
    // owned cursor position only clears OUR owned rows.
    //
    // Cols-drift risk: under silent cols change, `cursorRowInLive` is
    // stale by 1-2 rows. Walk-up overshoot lands in scrollback; `\x1b[J`
    // then clears 1-2 scrollback rows. Bounded; acceptable trade-off.
    parts.push("\x1b[J")
    this.liveHeightValue = 0
    this.cursorRowInLive = 0
    this.drawnLiveKey = null
    if (includeSepRows) this.sepRowsAboveLive = 0
    return parts.join("")
  }

  /**
   * Cursor's physical-row offset from the top of the previously-drawn
   * live area, given the effective cols RIGHT NOW.
   *
   * Mirrors {@link EditorRenderer}'s wrap math (and {@link wrapRows}
   * in `term-width.ts`) so we agree with the renderer that produced
   * the cells in the first place. Used by {@link eraseLiveSeq} to
   * walk the cursor up to the actual top of the on-screen live area,
   * even when the terminal has reflowed previously-drawn cells under
   * a smaller cols since the last paint.
   *
   * Behavior:
   *   - Stable cols (`cols === lastDrawColumns`): every drawn line is
   *     ≤ cols cells wide, so each contributes exactly 1 physical row;
   *     the result equals the stored logical `cursor.row`, which is
   *     what `cursorRowInLive` was set to in {@link drawLiveSeq}. No
   *     behavioral change vs the pre-fix code.
   *   - Cols drift smaller than `lastDrawColumns`: lines whose
   *     `displayWidth` exceeds the new cols wrap on the terminal
   *     side. Each such line above the cursor contributes
   *     `ceil(width / cols) - 1` extra physical rows; within the
   *     cursor's own line, `floor(cursor.col / cols)` extra wrap
   *     chunks sit above the cursor. The result is the correct
   *     physical walk-up to reach the top of the reflowed live area.
   *   - Cols drift larger than `lastDrawColumns`: lines fit unchanged
   *     (they were sized at the smaller `lastDrawColumns` and the
   *     terminal won't pack them tighter), so the result still
   *     equals the logical `cursor.row`. No-op.
   *
   * Assumes the terminal preserved the cursor's CHARACTER position
   * across the resize — true for iTerm2, kitty, GNOME Terminal,
   * xterm, tmux, macOS Terminal.app, etc. On a terminal that pins
   * the cursor to the same physical row instead, this can overshoot
   * by the wrap delta and the subsequent `\x1b[J` would clear that
   * many rows of scrollback. The overshoot is bounded by
   * `physicalLiveArea - cursorRowInLive` (a handful of rows in
   * practice) and is vastly better than the pre-fix orphan
   * accumulation, where every cols-drifting paint left rows in
   * scrollback unbounded across the lifetime of the session.
   *
   * Falls back to `this.cursorRowInLive` (legacy logical count) when
   * the cursor / lines snapshot is unusable (cursor null,
   * `effectiveColumns()` is 0, or drawn lines absent).
   */
  private computePhysicalCursorRowInLive(
    drawnLines: string[],
    drawnCursor: { row: number; col: number } | null,
  ): number {
    const cols = this.effectiveColumns()
    if (cols <= 0 || !drawnCursor) return this.cursorRowInLive
    let phys = 0
    const upTo = Math.min(drawnCursor.row, drawnLines.length)
    for (let i = 0; i < upTo; i++) {
      const line = drawnLines[i]
      if (line === undefined) break
      const w = displayWidth(line)
      phys += Math.max(1, Math.ceil(w / cols))
    }
    if (drawnCursor.col > 0) phys += Math.floor(drawnCursor.col / cols)
    return phys
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
      // Order is content → EL → CRLF. FakeTerminal / typical DECAWM
      // implementations clear wrap-pending on EL, so this does not by
      // itself add a physical row when a line fills every cell; the
      // editor still clamps status to cols-1 as belt-and-suspenders
      // (MA-481485). Do NOT change liveHeightValue to a physical wrap
      // sum here: cursorRowInLive and unmount's downRows math stay
      // logical, and eraseLiveSeq already walks physical rows via
      // computePhysicalCursorRowInLive.
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
  // mdstream styled code lines erase with `\r\x1b[K` (EL), not only
  // `\r\x1b[J` / CUU+J full clears. Treat both as redraw anchors so
  // streamCol tracks the painted suffix, not pre-erase width.
  const redraw = /\x1b\[\d*A\r\x1b\[(?:0)?J|\r\x1b\[(?:0)?J|\r\x1b\[(?:0)?K/g
  for (const match of chunk.matchAll(redraw)) {
    end = (match.index ?? 0) + match[0].length
  }
  return end === -1 ? null : chunk.slice(end)
}

/**
 * Raw-mode TTY: convert bare LF to CRLF without doubling existing CRLF.
 * Idempotent. Non-TTY callers must not use this (pipes keep LF).
 */
export function normalizeLfToCrlf(chunk: string): string {
  return chunk.replace(/\r?\n/g, "\r\n")
}

function liveAreaKey(lines: string[], cursor: { row: number; col: number } | null): string {
  return JSON.stringify([lines, cursor])
}

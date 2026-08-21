/**
 * Tiny in-process terminal emulator used by render-bug regression tests.
 *
 * Goal: take an arbitrary byte stream containing text, CR/LF, and the
 * subset of CSI/SGR sequences our compositor + formatter actually emit,
 * and produce a stable view of "what a real terminal would show", so
 * tests can assert against the screen + scrollback without spinning up
 * tmux or pulling in `pyte`.
 *
 * Scope (intentionally narrow — extend on demand):
 * - Printable text, CR (`\r`), LF (`\n` or `\x0a`), BS (`\x08`).
 * - CSI cursor: `A` up, `B` down, `C` forward, `D` back; default 1.
 * - CSI line: `\x1b[K` erase to EOL (param 0 only).
 * - CSI screen: `\x1b[J` erase from cursor to end of screen (param 0).
 * - CSI absolute: `\x1b[H`, `\x1b[<r>;<c>H` cursor home / set position.
 * - SGR (`\x1b[...m`) — swallowed, doesn't move cursor or affect text.
 * - DEC private modes `\x1b[?...h` / `\x1b[?...l` — swallowed.
 * - OSC `\x1b]...\x07` — swallowed.
 *
 * Display-width: codepoints in our `term-width.ts` "wide" set count as
 * 2 cells; combining marks count as 0 (attached to previous cell).
 *
 * Wrap behaviour matches xterm/iTerm "deferred wrap": the cursor is
 * allowed to sit at column = `cols` (one past the last drawable cell).
 * The next *printable* character forces a wrap (LF + CR) before drawing.
 *
 * Scrollback: when LF moves cursor past the bottom row, the top row is
 * popped and pushed to `scrollback`. There's no scroll region; we don't
 * need DECSTBM for the cases we test.
 *
 * @module test-utils/fake-terminal
 */

import { codePointWidth } from "../terminal/term-width.ts"

export interface FakeTerminalOptions {
  cols?: number
  rows?: number
  /** Soft cap so a runaway test doesn't OOM. */
  scrollbackLimit?: number
  /**
   * When `true` (strict / VT520-derived semantics), executing EL (`ESC[K`)
   * or ED (`ESC[J`) does NOT cancel the deferred-wrap (wrap-pending) flag.
   * A few real emulator families behave this way; most (xterm, iTerm2,
   * kitty) cancel it. Defaults to `false` (lenient, matches xterm).
   */
  elPreservesWrapPending?: boolean
}

interface Cell {
  ch: string
  width: 1 | 2
}

/**
 * Headless terminal emulator for tests: feed it raw output (text + ANSI
 * escapes) and read back the rendered grid and scrollback as strings.
 * Implements the subset the compositor exercises, including wide (CJK/emoji)
 * cells, deferred wrap at the right margin, and partial escape sequences
 * split across `feed` calls.
 */
export class FakeTerminal {
  readonly cols: number
  readonly rows: number
  private grid: Cell[][]
  private cursorRow = 0
  private cursorCol = 0
  /** Deferred-wrap pending: cursor sat at col=cols after a print. */
  private pendingWrap = false
  private readonly elPreservesWrapPending: boolean
  readonly scrollback: string[] = []
  private scrollbackLimit: number
  /** Bytes left over from a previous feed() that ended mid-escape. */
  private pending = ""

  constructor(opts: FakeTerminalOptions = {}) {
    this.cols = Math.max(1, opts.cols ?? 80)
    this.rows = Math.max(1, opts.rows ?? 24)
    this.scrollbackLimit = opts.scrollbackLimit ?? 5_000
    this.elPreservesWrapPending = opts.elPreservesWrapPending === true
    this.grid = Array.from({ length: this.rows }, () => this.blankRow())
  }

  private blankRow(): Cell[] {
    return Array.from({ length: this.cols }, () => ({ ch: " ", width: 1 }))
  }

  /** Feed bytes (or a string) to the emulator. */
  feed(input: string | Uint8Array): void {
    const incoming = typeof input === "string" ? input : new TextDecoder().decode(input)
    const text = this.pending + incoming
    this.pending = ""
    let i = 0
    while (i < text.length) {
      const ch = text[i]
      const code = text.charCodeAt(i)

      if (ch === "\x1b") {
        const consumed = this.handleEscape(text, i)
        if (consumed === -1) {
          // Incomplete escape — stash for next feed().
          this.pending = text.slice(i)
          return
        }
        i = consumed
        continue
      }
      if (ch === "\r") {
        this.cursorCol = 0
        this.pendingWrap = false
        i++
        continue
      }
      if (ch === "\n") {
        this.lineFeed()
        i++
        continue
      }
      if (ch === "\b") {
        if (this.cursorCol > 0) this.cursorCol--
        this.pendingWrap = false
        i++
        continue
      }
      if (ch === "\x07") {
        // BEL — ignore.
        i++
        continue
      }
      if (code < 0x20) {
        // Other C0 controls we don't model; skip.
        i++
        continue
      }

      // Printable code point (handle surrogate pairs).
      let cp = text.codePointAt(i) ?? 0x20
      let consumed = cp > 0xffff ? 2 : 1
      this.printCodePoint(cp)
      i += consumed
    }
  }

  /** Snapshot of the visible rows, with trailing spaces trimmed. */
  screen(): string[] {
    return this.grid.map((row) => rowToString(row).replace(/ +$/, ""))
  }

  /** Combined scrollback + visible screen. */
  fullText(): string {
    return [...this.scrollback, ...this.screen()].join("\n")
  }

  cursor(): { row: number; col: number } {
    return { row: this.cursorRow, col: this.cursorCol }
  }

  // ------------------------- internals -------------------------

  private printCodePoint(cp: number): void {
    const w = codePointWidth(cp) as 0 | 1 | 2
    if (w === 0) {
      // Combining mark: attach to previous cell if any.
      if (this.cursorCol > 0) {
        const prev = this.grid[this.cursorRow][this.cursorCol - 1]
        prev.ch = prev.ch + String.fromCodePoint(cp)
      }
      return
    }

    if (this.pendingWrap) {
      this.cursorCol = 0
      this.lineFeed()
      this.pendingWrap = false
    }

    if (this.cursorCol + w > this.cols) {
      // Doesn't fit on current row — wrap.
      this.cursorCol = 0
      this.lineFeed()
    }

    const row = this.grid[this.cursorRow]
    row[this.cursorCol] = { ch: String.fromCodePoint(cp), width: w as 1 | 2 }
    if (w === 2 && this.cursorCol + 1 < this.cols) {
      // Mark the second cell as "tail" so the row renders correctly.
      row[this.cursorCol + 1] = { ch: "", width: 1 }
    }
    this.cursorCol += w
    if (this.cursorCol >= this.cols) {
      this.cursorCol = this.cols
      this.pendingWrap = true
    }
  }

  private lineFeed(): void {
    // Strict (VT520-derived) semantics: a pending deferred wrap is
    // resolved by LF as its own row advance BEFORE the line feed, so the
    // cursor drops two rows total. Lenient (xterm/iTerm2) semantics:
    // pendingWrap is simply cleared and LF advances one row.
    if (this.pendingWrap && this.elPreservesWrapPending) {
      this.pendingWrap = false
      this.lineFeedLenient()
    }
    this.lineFeedLenient()
  }

  private lineFeedLenient(): void {
    this.pendingWrap = false
    if (this.cursorRow < this.rows - 1) {
      this.cursorRow++
      return
    }
    // Bottom row: scroll.
    const top = rowToString(this.grid[0]).replace(/ +$/, "")
    this.scrollback.push(top)
    if (this.scrollback.length > this.scrollbackLimit) {
      this.scrollback.splice(0, this.scrollback.length - this.scrollbackLimit)
    }
    this.grid.shift()
    this.grid.push(this.blankRow())
  }

  /**
   * Returns the index just past the consumed escape sequence, or -1 if
   * the sequence is incomplete and the caller should buffer it.
   */
  private handleEscape(text: string, start: number): number {
    const next = text[start + 1]
    if (next === undefined) return -1

    // OSC: ESC ] ... BEL (or ST). We only consume up to BEL.
    if (next === "]") {
      const bel = text.indexOf("\x07", start + 2)
      if (bel === -1) return -1
      return bel + 1
    }

    if (next !== "[") {
      // Two-byte ESC (e.g. ESC = ESC > etc) — skip.
      return start + 2
    }

    // CSI: ESC [ <params> <intermediates> <final>
    let i = start + 2
    let params = ""
    let isPrivate = false
    if (i >= text.length) return -1
    if (text[i] === "?" || text[i] === ">" || text[i] === "<" || text[i] === "=") {
      isPrivate = true
      params += text[i]
      i++
    }
    while (i < text.length) {
      const c = text[i]
      const cc = c.charCodeAt(0)
      if (cc >= 0x30 && cc <= 0x3f) {
        // Parameter byte (0-9 ; : < = > ?).
        params += c
        i++
        continue
      }
      if (cc >= 0x20 && cc <= 0x2f) {
        // Intermediate byte.
        params += c
        i++
        continue
      }
      // Final byte 0x40-0x7e.
      this.dispatchCsi(params, c, isPrivate)
      return i + 1
    }
    // Ran out of input mid-CSI — incomplete.
    return -1
  }

  private dispatchCsi(params: string, finalByte: string, isPrivate: boolean): void {
    if (isPrivate) {
      // DEC private mode set/reset, etc — ignored for our purposes.
      return
    }
    const nums = params.length === 0 ? [] : params.split(";").map((p) => parseInt(p, 10))
    const def = (i: number, d: number): number => {
      const v = nums[i]
      return Number.isFinite(v) ? (v as number) : d
    }
    switch (finalByte) {
      case "A": {
        const n = Math.max(1, def(0, 1))
        this.cursorRow = Math.max(0, this.cursorRow - n)
        this.pendingWrap = false
        return
      }
      case "B": {
        const n = Math.max(1, def(0, 1))
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n)
        this.pendingWrap = false
        return
      }
      case "C": {
        const n = Math.max(1, def(0, 1))
        this.cursorCol = Math.min(this.cols, this.cursorCol + n)
        this.pendingWrap = false
        return
      }
      case "D": {
        const n = Math.max(1, def(0, 1))
        this.cursorCol = Math.max(0, this.cursorCol - n)
        this.pendingWrap = false
        return
      }
      case "G": {
        const n = Math.max(1, def(0, 1))
        this.cursorCol = Math.min(this.cols, n - 1)
        this.pendingWrap = false
        return
      }
      case "H":
      case "f": {
        const r = Math.max(1, def(0, 1))
        const c = Math.max(1, def(1, 1))
        this.cursorRow = Math.min(this.rows - 1, r - 1)
        this.cursorCol = Math.min(this.cols, c - 1)
        this.pendingWrap = false
        return
      }
      case "K": {
        const mode = def(0, 0)
        const row = this.grid[this.cursorRow]
        if (mode === 0) {
          for (let c = this.cursorCol; c < this.cols; c++) row[c] = { ch: " ", width: 1 }
        } else if (mode === 1) {
          for (let c = 0; c <= this.cursorCol && c < this.cols; c++) row[c] = { ch: " ", width: 1 }
        } else if (mode === 2) {
          for (let c = 0; c < this.cols; c++) row[c] = { ch: " ", width: 1 }
        }
        if (!this.elPreservesWrapPending) this.pendingWrap = false
        return
      }
      case "J": {
        const mode = def(0, 0)
        if (mode === 0) {
          // Erase from cursor to end of screen.
          const row = this.grid[this.cursorRow]
          for (let c = this.cursorCol; c < this.cols; c++) row[c] = { ch: " ", width: 1 }
          for (let r = this.cursorRow + 1; r < this.rows; r++) this.grid[r] = this.blankRow()
        } else if (mode === 2) {
          for (let r = 0; r < this.rows; r++) this.grid[r] = this.blankRow()
        }
        if (!this.elPreservesWrapPending) this.pendingWrap = false
        return
      }
      case "m":
        // SGR — visual only, no movement.
        return
      default:
        // Unknown CSI — ignore.
        return
    }
  }
}

function rowToString(row: Cell[]): string {
  let out = ""
  for (const cell of row) {
    if (cell.width === 1 && cell.ch === "") continue // wide-char tail
    out += cell.ch
  }
  return out
}

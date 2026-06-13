/**
 * Multiline text buffer backing {@link RawInput} (`src/input.ts`): an
 * array of logical lines plus a (row, col) cursor measured in CODE
 * POINTS, with the readline-style editing operations the raw-mode
 * reader needs (insert, delete, kill, word motion, paste).
 *
 * Extracted verbatim from `RawInput`'s private methods so the input
 * module stays under the repo's `max-lines` budget. Pure buffer state +
 * mutations only - no terminal I/O, no wrap-aware rendering math (that
 * stays in `RawInput`, which owns prompt widths and terminal columns).
 *
 * @module input/line-buffer
 */

import { isPrintableChar } from "./key-codec.ts"

/**
 * Logical line storage + cursor + editing ops for the raw-input reader.
 *
 * All columns are code-point indexes (NOT UTF-16 units, NOT display
 * cells); `Array.from` segmentation is used throughout so surrogate
 * pairs count as one column.
 */
export class LineBuffer {
  /** Logical lines, without trailing `\n` separators. */
  lines: string[] = [""]
  /** Cursor row: index into {@link lines}. */
  row = 0
  /** Cursor column in code points within `lines[row]`. */
  col = 0

  /** Reset to a single empty line with the cursor at origin. */
  clear(): void {
    this.lines = [""]
    this.row = 0
    this.col = 0
  }

  /**
   * "Blank" means the buffer holds nothing the user typed — exactly one
   * empty logical line. This is intentionally narrower than
   * `lines.join("\n").trim() === ""`: a multi-line buffer made of blank
   * lines is real content the user composed, and pressing Enter on it
   * should submit (or insert another newline), not silently wipe it.
   */
  isBlank(): boolean {
    return this.lines.length === 1 && this.lines[0].length === 0
  }

  /** Insert `text` at the cursor and advance the cursor past it. */
  insertText(text: string): boolean {
    const [before, after] = this.splitAt(this.lines[this.row], this.col)
    this.lines[this.row] = before + text + after
    this.col += this.charLength(text)
    return true
  }

  /** Split the current line at the cursor, moving to the new line's start. */
  insertNewline(): boolean {
    const [before, after] = this.splitAt(this.lines[this.row], this.col)
    this.lines.splice(this.row, 1, before, after)
    this.row += 1
    this.col = 0
    return true
  }

  /** Backspace: delete the code point before the cursor (or join lines). */
  deleteBackward(): boolean {
    if (this.col > 0) {
      this.lines[this.row] = this.removeRange(this.lines[this.row], this.col - 1, this.col)
      this.col -= 1
      return true
    }

    if (this.row === 0) {
      return false
    }

    const previous = this.lines[this.row - 1]
    const current = this.lines[this.row]
    const previousLength = this.charLength(previous)
    this.lines.splice(this.row - 1, 2, previous + current)
    this.row -= 1
    this.col = previousLength
    return true
  }

  /** Delete the code point under the cursor (or join with the next line). */
  deleteForward(): boolean {
    const line = this.lines[this.row]
    const lineLength = this.charLength(line)

    if (this.col < lineLength) {
      this.lines[this.row] = this.removeRange(line, this.col, this.col + 1)
      return true
    }

    if (this.row >= this.lines.length - 1) {
      return false
    }

    this.lines.splice(this.row, 2, line + this.lines[this.row + 1])
    return true
  }

  /** Move one code point left, wrapping to the previous line's end. */
  moveLeft(): boolean {
    if (this.col > 0) {
      this.col -= 1
      return true
    }

    if (this.row === 0) {
      return false
    }

    this.row -= 1
    this.col = this.lineLength(this.row)
    return true
  }

  /** Move one code point right, wrapping to the next line's start. */
  moveRight(): boolean {
    const lineLength = this.lineLength(this.row)
    if (this.col < lineLength) {
      this.col += 1
      return true
    }

    if (this.row >= this.lines.length - 1) {
      return false
    }

    this.row += 1
    this.col = 0
    return true
  }

  /** Jump to the previous word boundary (line breaks count as whitespace). */
  moveWordLeft(): boolean {
    const [row, col] = this.scanWordLeft(this.row, this.col)
    if (row === this.row && col === this.col) {
      return false
    }
    this.row = row
    this.col = col
    return true
  }

  /** Mirror of {@link moveWordLeft} going forward. */
  moveWordRight(): boolean {
    const [row, col] = this.scanWordRight(this.row, this.col)
    if (row === this.row && col === this.col) {
      return false
    }
    this.row = row
    this.col = col
    return true
  }

  /**
   * Walk left from (row, col) over one "word", treating line breaks as
   * whitespace. Mirrors `EditorBuffer.scanWordLeft` so multi-line word
   * motion / delete behave the same in both code paths.
   */
  scanWordLeft(row: number, col: number): [number, number] {
    let r = row
    let c = col
    while (true) {
      if (c === 0) {
        if (r === 0) break
        r -= 1
        c = this.lineLength(r)
        continue
      }
      const chars = this.lineChars(r)
      if (!this.isWhitespace(chars[c - 1])) break
      c -= 1
    }
    while (c > 0) {
      const chars = this.lineChars(r)
      if (this.isWhitespace(chars[c - 1])) break
      c -= 1
    }
    return [r, c]
  }

  /**
   * Mirror of {@link scanWordLeft} going forward.
   */
  scanWordRight(row: number, col: number): [number, number] {
    let r = row
    let c = col
    while (true) {
      const lineLen = this.lineLength(r)
      if (c === lineLen) {
        if (r === this.lines.length - 1) break
        r += 1
        c = 0
        continue
      }
      const chars = this.lineChars(r)
      if (!this.isWhitespace(chars[c])) break
      c += 1
    }
    while (true) {
      const lineLen = this.lineLength(r)
      if (c === lineLen) break
      const chars = this.lineChars(r)
      if (this.isWhitespace(chars[c])) break
      c += 1
    }
    return [r, c]
  }

  /** Move the cursor to column 0 of the current line. */
  moveLineStart(): boolean {
    if (this.col === 0) {
      return false
    }
    this.col = 0
    return true
  }

  /** Move the cursor past the last code point of the current line. */
  moveLineEnd(): boolean {
    const nextCol = this.lineLength(this.row)
    if (this.col === nextCol) {
      return false
    }
    this.col = nextCol
    return true
  }

  /** Ctrl+K: kill to end of line, or join when already at the end. */
  killToLineEnd(): boolean {
    const lineLength = this.lineLength(this.row)
    if (this.col < lineLength) {
      this.lines[this.row] = this.sliceChars(this.lines[this.row], 0, this.col)
      return true
    }

    if (this.row >= this.lines.length - 1) {
      return false
    }

    this.lines.splice(this.row, 2, this.lines[this.row] + this.lines[this.row + 1])
    return true
  }

  /** Ctrl+U: kill from the start of the line to the cursor. */
  killToLineStart(): boolean {
    if (this.col === 0) {
      return false
    }

    this.lines[this.row] = this.sliceChars(this.lines[this.row], this.col)
    this.col = 0
    return true
  }

  /** Ctrl+W: delete the word before the cursor (may join lines). */
  deleteWordBackward(): boolean {
    const endRow = this.row
    const endCol = this.col
    const [startRow, startCol] = this.scanWordLeft(endRow, endCol)
    if (startRow === endRow && startCol === endCol) {
      return false
    }
    if (startRow === endRow) {
      const chars = this.lineChars(endRow)
      this.lines[endRow] = chars.slice(0, startCol).join("") + chars.slice(endCol).join("")
    } else {
      const startChars = this.lineChars(startRow)
      const endChars = this.lineChars(endRow)
      const merged = startChars.slice(0, startCol).join("") + endChars.slice(endCol).join("")
      this.lines.splice(startRow, endRow - startRow + 1, merged)
    }
    this.row = startRow
    this.col = startCol
    return true
  }

  /**
   * Insert pasted text: printable runs and tabs are inserted verbatim,
   * CRLF / LFCR pairs are coalesced into single newlines, and all other
   * control bytes are dropped. Returns `true` when anything changed.
   */
  insertPastedText(text: string): boolean {
    let changed = false
    let run = ""

    const flushRun = () => {
      if (!run) {
        return
      }
      this.insertText(run)
      run = ""
      changed = true
    }

    for (let i = 0; i < text.length; ) {
      const codePoint = text.codePointAt(i)
      if (codePoint === undefined) {
        break
      }

      const char = String.fromCodePoint(codePoint)
      i += char.length

      if (char === "\r" || char === "\n") {
        flushRun()
        if (i < text.length) {
          const next = text[i]
          if ((char === "\r" && next === "\n") || (char === "\n" && next === "\r")) {
            i += 1
          }
        }
        this.insertNewline()
        changed = true
        continue
      }

      if (char === "\t" || isPrintableChar(char)) {
        run += char
      }
    }

    flushRun()
    return changed
  }

  /** Code-point length of `lines[row]`. */
  lineLength(row: number): number {
    return this.charLength(this.lines[row])
  }

  /** `lines[row]` split into code-point characters. */
  lineChars(row: number): string[] {
    return Array.from(this.lines[row])
  }

  /** Code-point length of `text`. */
  charLength(text: string): number {
    return Array.from(text).length
  }

  private splitAt(text: string, index: number): [string, string] {
    const chars = Array.from(text)
    return [chars.slice(0, index).join(""), chars.slice(index).join("")]
  }

  private sliceChars(text: string, start: number, end?: number): string {
    return Array.from(text).slice(start, end).join("")
  }

  private removeRange(text: string, start: number, end: number): string {
    const chars = Array.from(text)
    return chars.slice(0, start).join("") + chars.slice(end).join("")
  }

  private isWhitespace(char: string): boolean {
    return /\s/u.test(char)
  }
}

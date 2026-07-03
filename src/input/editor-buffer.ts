/**
 * Pure model of a multiline text buffer with a single cursor.
 *
 * Extracted from {@link RawInput} so the editor state can live independently
 * of the raw-mode keystroke pump and the terminal renderer. Used by the
 * Compositor-driven persistent editor: the controller mutates the buffer
 * and asks the renderer to repaint the live area.
 *
 * All position units are unicode code points (matching `Array.from(line)`),
 * so emoji and other multi-code-unit characters count as one column.
 *
 * @module editor-buffer
 */

/**
 * Multiline text buffer plus cursor, with all mutation methods (insert,
 * delete, cursor movement) operating in code-point columns. Holds no terminal
 * or rendering state, which keeps it unit-testable and lets the controller
 * and renderer evolve independently.
 */
export class EditorBuffer {
  private linesValue: string[] = [""]
  private rowValue = 0
  private colValue = 0

  get lines(): readonly string[] {
    return this.linesValue
  }

  get row(): number {
    return this.rowValue
  }

  set row(value: number) {
    this.rowValue = Math.max(0, Math.min(value, this.linesValue.length - 1))
    this.colValue = Math.min(this.colValue, this.lineLength(this.rowValue))
  }

  get col(): number {
    return this.colValue
  }

  set col(value: number) {
    this.colValue = Math.max(0, Math.min(value, this.lineLength(this.rowValue)))
  }

  toString(): string {
    return this.linesValue.join("\n")
  }

  /**
   * `true` only for the brand-new empty single-line buffer. A multi-line
   * buffer made of whitespace is *real content* the user composed and must
   * not be silently wiped by Ctrl+C / Enter heuristics. See the matching
   * `RawInput.isBlankBuffer` for the same rationale.
   */
  isBlank(): boolean {
    return this.linesValue.length === 1 && this.linesValue[0].length === 0
  }

  clear(): void {
    this.linesValue = [""]
    this.rowValue = 0
    this.colValue = 0
  }

  insert(text: string): boolean {
    if (text.length === 0) return false
    const [before, after] = this.splitAt(this.linesValue[this.rowValue], this.colValue)
    this.linesValue[this.rowValue] = before + text + after
    this.colValue += this.charLength(text)
    return true
  }

  newline(): boolean {
    const [before, after] = this.splitAt(this.linesValue[this.rowValue], this.colValue)
    this.linesValue.splice(this.rowValue, 1, before, after)
    this.rowValue += 1
    this.colValue = 0
    return true
  }

  deleteBackward(): boolean {
    if (this.colValue > 0) {
      this.linesValue[this.rowValue] = this.removeRange(
        this.linesValue[this.rowValue],
        this.colValue - 1,
        this.colValue,
      )
      this.colValue -= 1
      return true
    }
    if (this.rowValue === 0) return false
    const previous = this.linesValue[this.rowValue - 1]
    const current = this.linesValue[this.rowValue]
    const previousLength = this.charLength(previous)
    this.linesValue.splice(this.rowValue - 1, 2, previous + current)
    this.rowValue -= 1
    this.colValue = previousLength
    return true
  }

  deleteForward(): boolean {
    const line = this.linesValue[this.rowValue]
    const lineLength = this.charLength(line)
    if (this.colValue < lineLength) {
      this.linesValue[this.rowValue] = this.removeRange(line, this.colValue, this.colValue + 1)
      return true
    }
    if (this.rowValue >= this.linesValue.length - 1) return false
    this.linesValue.splice(this.rowValue, 2, line + this.linesValue[this.rowValue + 1])
    return true
  }

  moveLeft(): boolean {
    if (this.colValue > 0) {
      this.colValue -= 1
      return true
    }
    if (this.rowValue === 0) return false
    this.rowValue -= 1
    this.colValue = this.lineLength(this.rowValue)
    return true
  }

  moveRight(): boolean {
    const lineLength = this.lineLength(this.rowValue)
    if (this.colValue < lineLength) {
      this.colValue += 1
      return true
    }
    if (this.rowValue >= this.linesValue.length - 1) return false
    this.rowValue += 1
    this.colValue = 0
    return true
  }

  moveUp(): boolean {
    if (this.rowValue === 0) return false
    this.rowValue -= 1
    this.colValue = Math.min(this.colValue, this.lineLength(this.rowValue))
    return true
  }

  moveDown(): boolean {
    if (this.rowValue >= this.linesValue.length - 1) return false
    this.rowValue += 1
    this.colValue = Math.min(this.colValue, this.lineLength(this.rowValue))
    return true
  }

  moveLineStart(): boolean {
    if (this.colValue === 0) return false
    this.colValue = 0
    return true
  }

  moveLineEnd(): boolean {
    const next = this.lineLength(this.rowValue)
    if (this.colValue === next) return false
    this.colValue = next
    return true
  }

  moveWordLeft(): boolean {
    const [row, col] = this.scanWordLeft(this.rowValue, this.colValue)
    if (row === this.rowValue && col === this.colValue) return false
    this.rowValue = row
    this.colValue = col
    return true
  }

  moveWordRight(): boolean {
    const [row, col] = this.scanWordRight(this.rowValue, this.colValue)
    if (row === this.rowValue && col === this.colValue) return false
    this.rowValue = row
    this.colValue = col
    return true
  }

  killToLineEnd(): boolean {
    const lineLength = this.lineLength(this.rowValue)
    if (this.colValue < lineLength) {
      this.linesValue[this.rowValue] = this.sliceChars(
        this.linesValue[this.rowValue],
        0,
        this.colValue,
      )
      return true
    }
    if (this.rowValue >= this.linesValue.length - 1) return false
    this.linesValue.splice(
      this.rowValue,
      2,
      this.linesValue[this.rowValue] + this.linesValue[this.rowValue + 1],
    )
    return true
  }

  killToLineStart(): boolean {
    if (this.colValue === 0) return false
    this.linesValue[this.rowValue] = this.sliceChars(this.linesValue[this.rowValue], this.colValue)
    this.colValue = 0
    return true
  }

  deleteWordBackward(): boolean {
    const endRow = this.rowValue
    const endCol = this.colValue
    const [startRow, startCol] = this.scanWordLeft(endRow, endCol)
    if (startRow === endRow && startCol === endCol) return false
    if (startRow === endRow) {
      const chars = this.lineChars(endRow)
      this.linesValue[endRow] = chars.slice(0, startCol).join("") + chars.slice(endCol).join("")
    } else {
      const startChars = this.lineChars(startRow)
      const endChars = this.lineChars(endRow)
      const merged = startChars.slice(0, startCol).join("") + endChars.slice(endCol).join("")
      this.linesValue.splice(startRow, endRow - startRow + 1, merged)
    }
    this.rowValue = startRow
    this.colValue = startCol
    return true
  }

  lineLength(row: number): number {
    return this.charLength(this.linesValue[row])
  }

  /**
   * Walk left from (row, col) over one "word", treating line breaks as
   * whitespace so cursor / delete motions cross line boundaries the same
   * way they would in any normal multi-line editor (VS Code, micro, nano,
   * macOS Terminal's word-left, etc.).
   *
   * Phase 1 eats whitespace to the left, hopping to the end of the
   * previous line when col reaches 0. Phase 2 then eats non-whitespace
   * until the next whitespace or buffer start. Stays put when there is
   * nothing to the left.
   */
  private scanWordLeft(row: number, col: number): [number, number] {
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
   * Mirror of {@link scanWordLeft} going forward. Treats newlines as
   * whitespace so the scan hops to the start of the next line when col
   * reaches the line's end.
   */
  private scanWordRight(row: number, col: number): [number, number] {
    let r = row
    let c = col
    while (true) {
      const lineLen = this.lineLength(r)
      if (c === lineLen) {
        if (r === this.linesValue.length - 1) break
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

  private lineChars(row: number): string[] {
    return Array.from(this.linesValue[row])
  }

  private charLength(text: string): number {
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

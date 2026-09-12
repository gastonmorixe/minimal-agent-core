/**
 * Flatten a realtime formatter's terminal output into static lines.
 *
 * A streaming markdown renderer (`mdstream`) does not emit a clean
 * append-only text stream. It repaints: it moves the cursor up, returns to
 * column 0, and erases, so a partially-rendered paragraph can be replaced
 * once the closing token arrives. Reading that byte stream as if every
 * `\n` started a new final line yields duplicated paragraphs and stray
 * escape fragments.
 *
 * That matters when the rendered output must live INSIDE framed chrome
 * (the `/compact` result block). The frame renderer prefixes every row
 * with a `│ ` gutter, so it needs the FINAL rows, not the repaint
 * choreography. Feeding raw formatter bytes to it tears the frame.
 *
 * {@link flattenAnsiToLines} replays the cursor-motion subset a line-based
 * renderer actually uses against a virtual screen, then returns the
 * resulting rows with their SGR styling intact. Colors and bold survive,
 * cursor motion does not.
 *
 * Scope: this is deliberately NOT a terminal emulator. It handles the
 * sequences a markdown stream emits (relative cursor motion, line/screen
 * erase, carriage return) and drops the rest. Absolute positioning, scroll
 * regions, and alternate screens are out of scope: a formatter that needs
 * them is not a fit for embedding in a frame.
 *
 * @module host/ui/formatter/ansi-flatten
 */

/** Escape that opens a Control Sequence Introducer: `ESC [`. */
const CSI = "\u001B["

/**
 * One row of the virtual screen: its text plus the styling prefix that was
 * active when the row began. Rows are edited in place as the stream
 * repaints them.
 */
interface Row {
  text: string
}

/** Cursor-motion state while replaying a formatter stream. */
interface Screen {
  rows: Row[]
  row: number
  col: number
}

function ensureRow(screen: Screen, index: number): Row {
  while (screen.rows.length <= index) screen.rows.push({ text: "" })
  return screen.rows[index] as Row
}

/**
 * Write `text` at the cursor, overwriting what is already there.
 *
 * Overwrite (not insert) is what a real terminal does, and it is what makes
 * a repaint replace the previous draft instead of appending to it. Short
 * rows are padded so a write past the end lands at the right column.
 */
function writeAt(screen: Screen, text: string): void {
  if (text.length === 0) return
  const row = ensureRow(screen, screen.row)
  const plain = row.text
  const padded = plain.length < screen.col ? plain + " ".repeat(screen.col - plain.length) : plain
  row.text = padded.slice(0, screen.col) + text + padded.slice(screen.col + text.length)
  screen.col += text.length
}

/** Erase within the current row per the CSI `K` parameter. */
function eraseInLine(screen: Screen, param: number): void {
  const row = ensureRow(screen, screen.row)
  if (param === 1) {
    const keep = row.text.slice(screen.col)
    row.text = " ".repeat(Math.min(screen.col, row.text.length)) + keep
    return
  }
  if (param === 2) {
    row.text = ""
    return
  }
  row.text = row.text.slice(0, screen.col)
}

/** Erase whole rows per the CSI `J` parameter. */
function eraseInDisplay(screen: Screen, param: number): void {
  if (param === 2 || param === 3) {
    screen.rows = []
    screen.row = 0
    screen.col = 0
    return
  }
  if (param === 1) {
    for (let i = 0; i < screen.row; i++) ensureRow(screen, i).text = ""
    eraseInLine(screen, 1)
    return
  }
  eraseInLine(screen, 0)
  screen.rows = screen.rows.slice(0, screen.row + 1)
}

/**
 * Apply one CSI sequence. Returns nothing: unknown finals are ignored on
 * purpose, so an unrecognized sequence degrades to "no motion" rather than
 * corrupting the flattened text.
 */
function applyCsi(screen: Screen, params: string, final: string): void {
  const first = Number.parseInt(params.split(";")[0] ?? "", 10)
  const n = Number.isFinite(first) ? first : final === "J" || final === "K" ? 0 : 1
  switch (final) {
    case "A":
      screen.row = Math.max(0, screen.row - Math.max(1, n))
      break
    case "B":
      screen.row = screen.row + Math.max(1, n)
      ensureRow(screen, screen.row)
      break
    case "C":
      screen.col = screen.col + Math.max(1, n)
      break
    case "D":
      screen.col = Math.max(0, screen.col - Math.max(1, n))
      break
    case "E":
      screen.row = screen.row + Math.max(1, n)
      screen.col = 0
      ensureRow(screen, screen.row)
      break
    case "F":
      screen.row = Math.max(0, screen.row - Math.max(1, n))
      screen.col = 0
      break
    case "G":
      screen.col = Math.max(0, Math.max(1, n) - 1)
      break
    case "K":
      eraseInLine(screen, Number.isFinite(first) ? first : 0)
      break
    case "J":
      eraseInDisplay(screen, Number.isFinite(first) ? first : 0)
      break
    default:
      break
  }
}

/**
 * Replay a formatter's terminal output and return the final static lines.
 *
 * SGR (color / bold / italic) sequences are preserved inline so the
 * flattened rows look exactly like what the terminal would have shown.
 * Cursor motion, line and screen erase, and carriage returns are consumed:
 * they shape WHERE text lands, and never survive into the output.
 *
 * Trailing blank rows are dropped, because a streaming renderer commonly
 * leaves the cursor parked on an empty final row.
 *
 * @param text - Raw bytes captured from the formatter's stdout.
 * @returns The final rows, in order, with SGR styling intact.
 */
export function flattenAnsiToLines(text: string): string[] {
  const screen: Screen = { rows: [], row: 0, col: 0 }
  let i = 0
  let pending = ""

  const flushPending = (): void => {
    if (pending.length === 0) return
    writeAt(screen, pending)
    pending = ""
  }

  while (i < text.length) {
    const ch = text[i] as string

    if (ch === "\u001B") {
      if (text.startsWith(CSI, i)) {
        let j = i + CSI.length
        while (j < text.length) {
          const code = text.charCodeAt(j)
          // Parameter and intermediate bytes precede the final byte.
          if (code >= 0x30 && code <= 0x3f) {
            j++
            continue
          }
          if (code >= 0x20 && code <= 0x2f) {
            j++
            continue
          }
          break
        }
        if (j >= text.length) {
          // Truncated sequence at end of stream: drop it.
          i = text.length
          break
        }
        const final = text[j] as string
        const params = text.slice(i + CSI.length, j)
        if (final === "m") {
          // Styling: keep verbatim, it must ride along with the text.
          pending += text.slice(i, j + 1)
        } else {
          flushPending()
          applyCsi(screen, params, final)
        }
        i = j + 1
        continue
      }
      // OSC and other escapes: skip the introducer and any terminator.
      if (text[i + 1] === "]") {
        const bel = text.indexOf("\u0007", i)
        const st = text.indexOf("\u001B\\", i)
        const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
        i = end === -1 ? text.length : end + (end === st ? 2 : 1)
        continue
      }
      i += 2
      continue
    }

    if (ch === "\n") {
      flushPending()
      screen.row += 1
      screen.col = 0
      ensureRow(screen, screen.row)
      i++
      continue
    }

    if (ch === "\r") {
      flushPending()
      screen.col = 0
      i++
      continue
    }

    if (ch === "\b") {
      flushPending()
      screen.col = Math.max(0, screen.col - 1)
      i++
      continue
    }

    pending += ch
    i++
  }

  flushPending()

  const out = screen.rows.map((r) => r.text.replace(/\s+$/u, ""))
  while (out.length > 0 && (out[out.length - 1] as string).length === 0) out.pop()
  return out
}

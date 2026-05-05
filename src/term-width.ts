/**
 * Terminal display-width helpers.
 *
 * The prompt entry's row math used to count code points, which made the
 * cursor drift on lines containing ANSI SGR escapes, combining marks, wide
 * East-Asian glyphs, or emoji. These helpers consolidate the width model so
 * `RawInput` and `EditorRenderer` agree on what one cell costs.
 *
 * The implementation is intentionally dependency-free and approximate:
 *   - SGR / CSI sequences are stripped.
 *   - Combining marks and zero-width joiners contribute 0 cells.
 *   - Code points in the canonical East-Asian Wide / Emoji ranges contribute
 *     2 cells.
 *   - Everything else printable contributes 1 cell.
 *
 * It is correct enough for prompts and ASCII-heavy chat input. It is *not* a
 * full Unicode UAX #11 implementation; if you start typing flag emoji or
 * heavy ZWJ sequences the rendering can still drift by a column.
 *
 * @module term-width
 */

const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

/** Strip ANSI CSI / SGR sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

/** Width in cells of a single code point. */
export function codePointWidth(cp: number): number {
  // Control characters: not printable, treat as 0 so callers don't crash.
  if (cp < 0x20 || cp === 0x7f) return 0

  // Zero-width: combining marks, ZWJ/ZWNJ, BOM, variation selectors.
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // Combining Diacritical Marks
    (cp >= 0x200b && cp <= 0x200f) || // ZWSP..RLM
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) || // bidi controls
    cp === 0x2060 || // word joiner
    cp === 0xfeff || // BOM
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xe0100 && cp <= 0xe01ef) // VS supplement
  ) {
    return 0
  }

  // Private Use Areas (Nerd Font glyphs land here) intentionally NOT
  // mapped to width 2. PUA cell width depends on the active font: a
  // patched Nerd Font renders them as 2 cells, an unpatched fallback
  // renders them as 1. Hard-coding "PUA = 2" jiggles the other case.
  // We rely on the spinner emitting byte-width-stable frames (see
  // BlinkingNerdSpinner.render's pulse-instead-of-blink comment) and
  // a plain 1-space gap in the status row, so width assumptions about
  // PUA never matter for layout stability. Falls through to the
  // generic "1 cell" return below.

  // Wide / Fullwidth ranges (subset of UAX #11 W/F).
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // Misc Symbols & Pictographs, Emoticons
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // Transport
    (cp >= 0x1f700 && cp <= 0x1f9ff) || // Alchemical..Supplemental Symbols
    (cp >= 0x1fa70 && cp <= 0x1faff) || // Symbols & Pictographs Ext-A
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Ext B..F
    (cp >= 0x30000 && cp <= 0x3fffd)
  ) {
    return 2
  }

  return 1
}

/** Display width of a string, in terminal cells. ANSI sequences are stripped. */
export function displayWidth(text: string): number {
  const clean = stripAnsi(text)
  let width = 0
  for (let i = 0; i < clean.length; ) {
    const cp = clean.codePointAt(i)
    if (cp === undefined) break
    width += codePointWidth(cp)
    i += cp > 0xffff ? 2 : 1
  }
  return width
}

/**
 * Truncate text to a terminal display width. CSI escapes are copied but do
 * not count as cells. If truncation happens and there is room, append "...".
 */
export function truncateDisplayWidth(text: string, maxWidth: number, suffix = "..."): string {
  if (maxWidth <= 0) return ""
  if (displayWidth(text) <= maxWidth) return text

  const suffixWidth = displayWidth(suffix)
  const useSuffix = suffixWidth > 0 && maxWidth > suffixWidth
  const bodyLimit = useSuffix ? maxWidth - suffixWidth : maxWidth
  let width = 0
  let out = ""
  let sawAnsi = false

  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) === 0x1b && text[i + 1] === "[") {
      let j = i + 2
      while (j < text.length) {
        const c = text.charCodeAt(j)
        j += 1
        if (c >= 0x40 && c <= 0x7e) break
      }
      out += text.slice(i, j)
      sawAnsi = true
      i = j
      continue
    }

    const cp = text.codePointAt(i)
    if (cp === undefined) break
    const ch = String.fromCodePoint(cp)
    const w = codePointWidth(cp)
    if (width + w > bodyLimit) break
    out += ch
    width += w
    i += ch.length
  }

  if (useSuffix) out += suffix
  if (sawAnsi) out += "\x1b[0m"
  return out
}

/**
 * How many physical rows a string of given display width occupies in a
 * terminal of `columns` cells.
 *
 * The exact-fill case (`width % columns === 0` and `width > 0`) returns
 * `width / columns`, *not* `width / columns + 1`: we want "10 chars in an
 * 80-col terminal" → 1 row, "80 chars" → 1 row, "81 chars" → 2 rows. This
 * matches every modern terminal's wrap behavior.
 */
export function wrapRows(width: number, columns: number): number {
  if (columns <= 0) return 1
  if (width <= 0) return 1
  return Math.ceil(width / columns)
}

/**
 * Physical row offset (0-based) of a cursor sitting `col` cells into a line
 * whose prompt occupies `promptWidth` cells, in a terminal of `columns`
 * cells. The exact-fill cursor (col == columns) sits at the *end* of the
 * current row, not the start of the next, matching how terminals draw it
 * before the next character forces a wrap.
 */
export function cursorRowOffset(promptWidth: number, col: number, columns: number): number {
  if (columns <= 0) return 0
  const total = promptWidth + col
  if (total <= 0) return 0
  // Subtract one so an exact-fill cursor stays on the current row.
  return Math.floor(Math.max(0, total - 1) / columns)
}

/** Visual column inside the current physical row (0-based). */
export function cursorVisualCol(promptWidth: number, col: number, columns: number): number {
  if (columns <= 0) return 0
  const total = promptWidth + col
  if (total === 0) return 0
  const mod = total % columns
  // Exact-fill: cursor visually at the right edge of the row.
  return mod === 0 ? columns : mod
}

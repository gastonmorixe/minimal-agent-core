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

  // Emoji-presentation code points that live in the BMP *below* the
  // 0x1F300 pictograph planes handled later. These default to emoji
  // (double-width) presentation per Unicode `Emoji_Presentation=Yes`, so
  // every modern terminal paints them 2 cells wide even though they sit
  // among otherwise-narrow symbol blocks. Without this, glyphs like ⏰
  // (U+23F0 alarm clock), ⌚ (U+231A watch), ⚡ (U+26A1), ✅ (U+2705), or
  // ⭐ (U+2B50) get measured as 1 cell, which drifts every layout that
  // contains one (e.g. the startup `tools` row's `⏰ CronCreate` chunks).
  //
  // Scope note: this is the `Emoji_Presentation=Yes` subset, NOT the
  // larger "has an emoji variation sequence" set. Glyphs that are
  // text-default (e.g. ✔ U+2714, ✦ U+2726, ❯ U+276F, ● U+25CF) only go
  // wide when followed by VS16 (U+FE0F), so they stay width 1 here and the
  // VS16 itself contributes 0 — matching the terminal's text presentation.
  if (
    (cp >= 0x231a && cp <= 0x231b) || // ⌚⌛
    (cp >= 0x23e9 && cp <= 0x23ec) || // ⏩⏪⏫⏬
    cp === 0x23f0 || // ⏰
    cp === 0x23f3 || // ⏳
    (cp >= 0x25fd && cp <= 0x25fe) || // ◽◾
    (cp >= 0x2614 && cp <= 0x2615) || // ☔☕
    (cp >= 0x2648 && cp <= 0x2653) || // zodiac ♈..♓
    cp === 0x267f || // ♿
    cp === 0x2693 || // ⚓
    cp === 0x26a1 || // ⚡
    (cp >= 0x26aa && cp <= 0x26ab) || // ⚪⚫
    (cp >= 0x26bd && cp <= 0x26be) || // ⚽⚾
    (cp >= 0x26c4 && cp <= 0x26c5) || // ⛄⛅
    cp === 0x26ce || // ⛎
    cp === 0x26d4 || // ⛔
    cp === 0x26ea || // ⛪
    (cp >= 0x26f2 && cp <= 0x26f3) || // ⛲⛳
    cp === 0x26f5 || // ⛵
    cp === 0x26fa || // ⛺
    cp === 0x26fd || // ⛽
    cp === 0x2705 || // ✅
    (cp >= 0x270a && cp <= 0x270b) || // ✊✋
    cp === 0x2728 || // ✨
    cp === 0x274c || // ❌
    cp === 0x274e || // ❎
    (cp >= 0x2753 && cp <= 0x2755) || // ❓❔❕
    cp === 0x2757 || // ❗
    (cp >= 0x2795 && cp <= 0x2797) || // ➕➖➗
    cp === 0x27b0 || // ➰
    cp === 0x27bf || // ➿
    (cp >= 0x2b1b && cp <= 0x2b1c) || // ⬛⬜
    cp === 0x2b50 || // ⭐
    cp === 0x2b55 // ⭕
  ) {
    return 2
  }

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
 * Expand `\t` (HT, 0x09) to the right number of ASCII spaces to land
 * the next character at the next tab stop, given the terminal column
 * the text *starts at*.
 *
 * Why this exists: a literal tab is a 0-cell glyph under
 * {@link codePointWidth}/{@link displayWidth} (matches how `cat -A`
 * shows it as `^I`), but every modern terminal renders it as an
 * advance to the next multiple-of-`tabSize` column. The two views
 * disagree by 1–`tabSize` cells, which is enough for a "just under
 * the cap" body row to overflow the visible columns and wrap into the
 * gutter. Callers that pre-expand tabs before measuring see a width
 * that matches what the terminal actually paints.
 *
 * `startCol` is the terminal column the first character of `text`
 * will occupy (0-indexed). For tool transcript body rows that's the
 * gutter width (4) — the body sits to the right of the `"  │ "`
 * prefix the renderer prepends. Pass 0 when the text already includes
 * its own leading prefix.
 *
 * ANSI CSI / SGR escapes pass through verbatim (they contribute 0
 * cells, same as `displayWidth`). After expansion the result contains
 * no `\t` characters and the visual rendering is identical (terminals
 * draw a tab as the same blank advance the replacement spaces
 * produce).
 */
export function expandTabs(text: string, startCol: number, tabSize = 8): string {
  if (text.indexOf("\t") === -1) return text
  const stops = Math.max(1, Math.floor(tabSize))
  let col = Math.max(0, Math.floor(startCol))
  let out = ""
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) === 0x1b && text[i + 1] === "[") {
      let j = i + 2
      while (j < text.length) {
        const c = text.charCodeAt(j)
        j += 1
        if (c >= 0x40 && c <= 0x7e) break
      }
      out += text.slice(i, j)
      i = j
      continue
    }
    const ch = text[i]
    if (ch === "\t") {
      const next = Math.floor(col / stops) * stops + stops
      out += " ".repeat(next - col)
      col = next
      i += 1
      continue
    }
    const cp = text.codePointAt(i)
    if (cp === undefined) break
    out += String.fromCodePoint(cp)
    col += codePointWidth(cp)
    i += cp > 0xffff ? 2 : 1
  }
  return out
}

/**
 * Word-wrap `text` to fit within `width` display cells.
 *
 * Splits on whitespace boundaries. Each output line fits within `width`
 * cells (measured by `displayWidth`). ANSI SGR sequences are preserved:
 * the last style-setting code is re-anchored at the start of each
 * continuation line so coloring is not lost across a wrap.
 *
 * A word that itself exceeds `width` is hard-broken at character
 * boundaries (preserving ANSI style on each fragment), so no output
 * line is ever wider than `width` unless `width <= 0`.
 *
 * Returns the original text as a single element when it already fits.
 * Always returns at least one element (never an empty array).
 */
export function wordWrap(text: string, width: number): string[] {
  if (width <= 0) return [text]
  if (displayWidth(text) <= width) return [text]

  // --- Tokenize into [ANSI* + word] segments ---
  // Split on whitespace, attaching any ANSI sequences that immediately
  // precede a word as its prefix.
  const words: string[] = []
  let ansiBuf = ""
  let wordBuf = ""

  for (let i = 0; i < text.length; ) {
    // ANSI escape sequence
    if (text.charCodeAt(i) === 0x1b && text[i + 1] === "[") {
      let j = i + 2
      while (j < text.length) {
        const c = text.charCodeAt(j)
        j += 1
        if (c >= 0x40 && c <= 0x7e) break
      }
      const seq = text.slice(i, j)
      // Flush accumulated word *before* this ANSI so the sequence
      // attaches to the *next* word.
      if (wordBuf) {
        words.push(ansiBuf + wordBuf)
        wordBuf = ""
        ansiBuf = ""
      }
      ansiBuf += seq
      i = j
      continue
    }

    const cp = text.codePointAt(i)
    if (cp === undefined) break
    const ch = String.fromCodePoint(cp)
    i += ch.length

    // Whitespace: flush any accumulated word
    if (ch === " " || ch === "\t") {
      if (wordBuf) {
        words.push(ansiBuf + wordBuf)
        wordBuf = ""
        ansiBuf = ""
      }
      continue
    }

    wordBuf += ch
  }
  // Flush trailing word. If only bare ANSI remains (no word text),
  // drop it: a style sequence floating unanchored has no visible effect
  // and emitting it as a zero-width word corrupts the layout.
  if (wordBuf) words.push(ansiBuf + wordBuf)
  else if (ansiBuf) {
    // Trailing-only ANSI (e.g. "text\x1b[0m" → after flushing "text",
    // ansiBuf="\x1b[0m"). Skip: the style was already applied to the
    // last word and the next line starts fresh.
  }

  if (words.length === 0) return [""]

  // --- Lay out words into lines ---
  const lines: string[] = []
  let cur = ""
  let curW = 0

  for (const w of words) {
    const wW = displayWidth(w)

    if (curW === 0) {
      // Start a fresh line. If the word itself is wider than width,
      // hard-break it into chunks.
      if (wW > width) {
        const chunks = hardBreakWord(w, width)
        for (let ci = 0; ci < chunks.length; ci++) {
          if (ci === 0) {
            cur = chunks[ci]
            curW = displayWidth(chunks[ci])
          } else {
            lines.push(cur)
            cur = chunks[ci]
            curW = displayWidth(chunks[ci])
          }
        }
      } else {
        cur = w
        curW = wW
      }
      continue
    }

    const spaceW = 1
    if (curW + spaceW + wW <= width) {
      cur += " " + w
      curW += spaceW + wW
    } else {
      lines.push(cur)
      // Carry the active style forward so the continuation line isn't
      // left unstyled. Build the set of *all* open SGR sequences from
      // the line we just closed (minus reset codes), so stacked
      // attributes like bold+red survive correctly.
      const carry = activeSgr(cur)
      if (wW > width) {
        // Word itself exceeds width; hard-break it into chunks.
        // The first chunk gets the carry style; subsequent chunks get
        // the carry too (if they don't already carry their own style).
        const chunks = hardBreakWord(w, width)
        for (let ci = 0; ci < chunks.length; ci++) {
          if (ci === 0) {
            cur = carry.length > 0 && !chunks[ci].startsWith("\x1b[") ? carry + chunks[ci] : chunks[ci]
            curW = displayWidth(cur)
          } else {
            lines.push(cur)
            cur = carry.length > 0 && !chunks[ci].startsWith("\x1b[") ? carry + chunks[ci] : chunks[ci]
            curW = displayWidth(cur)
          }
        }
      } else {
        cur = carry.length > 0 && !w.startsWith("\x1b[") ? carry + w : w
        curW = wW
      }
    }
  }
  if (cur.length > 0) lines.push(cur)

  return lines
}

/**
 * Hard-break a word (single token with no whitespace) at `width` display
 * cells. ANSI SGR sequences are carried to each continuation fragment so
 * styling is preserved.
 *
 * The caller ensures `width > 0` so this helper never enters an infinite
 * loop. Always returns at least one element.
 */
function hardBreakWord(word: string, width: number): string[] {
  if (displayWidth(word) <= width) return [word]
  const chunks: string[] = []
  let cur = ""
  let curW = 0
  let ansiState = ""

  for (let i = 0; i < word.length; ) {
    if (word.charCodeAt(i) === 0x1b && word[i + 1] === "[") {
      let j = i + 2
      while (j < word.length) {
        const c = word.charCodeAt(j)
        j += 1
        if (c >= 0x40 && c <= 0x7e) break
      }
      const seq = word.slice(i, j)
      cur += seq
      if (seq.endsWith("m")) {
        if (seq === "\x1b[0m" || seq === "\x1b[m") ansiState = ""
        else ansiState += seq
      }
      i = j
      continue
    }

    const cp = word.codePointAt(i)
    if (cp === undefined) break
    const ch = String.fromCodePoint(cp)
    const w = codePointWidth(cp)
    i += ch.length

    if (curW + w > width) {
      chunks.push(cur)
      cur = ansiState
      curW = 0
    }
    cur += ch
    curW += w
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

/**
 * Collect all currently-open SGR sequences in `s`, skipping reset codes
 * (`\x1b[0m` / `\x1b[m`) which clear the accumulator.
 *
 * Used by {@link wordWrap} to re-anchor terminal styling on wrapped
 * continuation lines. Unlike the simpler `lastStyleSgr` heuristic this
 * correctly handles:
 *
 *   - Stacked attributes: `\x1b[1m\x1b[31mtext` → both bold (1) and
 *     foreground (31) are captured, not just the last one.
 *   - Reset codes: `\x1b[32mtext\x1b[0m` → the reset clears the
 *     accumulator so the continuation line starts with no style.
 */
function activeSgr(s: string): string {
  const seqs: string[] = []
  for (let i = 0; i < s.length; ) {
    if (s.charCodeAt(i) === 0x1b && s[i + 1] === "[") {
      let j = i + 2
      while (j < s.length) {
        const c = s.charCodeAt(j)
        j += 1
        if (c >= 0x40 && c <= 0x7e) break
      }
      const seq = s.slice(i, j)
      if (seq.endsWith("m")) {
        // \x1b[0m or \x1b[m: reset all attributes.
        if (seq === "\x1b[0m" || seq === "\x1b[m") {
          seqs.length = 0
        } else {
          seqs.push(seq)
        }
      }
      // Non-SGR CSI sequences (cursor moves, etc.) are ignored for style
      // carry purposes — they have no persistent state.
      i = j
    } else {
      const cp = s.codePointAt(i)
      if (cp === undefined) break
      i += String.fromCodePoint(cp).length
    }
  }
  return seqs.join("")
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

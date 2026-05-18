/**
 * Detect the *visual* cell width of a sample Nerd Font glyph in the user's
 * terminal, via a Cursor Position Report (CPR, `ESC[6n`) probe.
 *
 * **Why this exists.** Nerd Font Material Design glyphs (`󱁤` =
 * U+F1064 "tools", `󰌾` = U+F033E "key-cog", etc.) live in Unicode's
 * Private Use Area. UAX #11 declares PUA codepoints "Ambiguous", which
 * means each terminal + font config gets to decide whether they render as
 * 1 cell or 2 cells. A patched Nerd Font renders them as 2 cells (the
 * glyph spans two character columns); an unpatched fallback font renders
 * them as 1. Hard-coding either value into `src/term-width.ts`
 * misaligns the agent's column model with the terminal's reality on the
 * other config. The status-row whitespace bug recurred ~10 times because
 * each "fix" picked one config and broke the other.
 *
 * The probe asks the terminal directly: print the glyph, ask the
 * terminal for the cursor's column after, subtract from the column
 * before. Cached for the session; refreshed only on explicit re-probe.
 *
 * **Protocol.**
 *   - Caller puts stdin in raw mode and attaches a `data` listener.
 *   - We `\r` to column 1, send `ESC[6n` (DSR-CPR) → terminal replies
 *     `ESC[<row>;<col>R`. Parse col0.
 *   - Print the sample glyph (no SGR).
 *   - Send `ESC[6n` again → reply gives col1.
 *   - `cells = clamp(col1 - col0, 1, 2)`.
 *   - Erase the visible artifact: `\r\x1b[K`.
 *   - Any non-CPR bytes that arrived during the probe (typeahead) are
 *     returned in `unparsed` so the caller can forward them to the
 *     editor.
 *
 * **Why two CPR queries instead of assuming col0=1.** Some terminals
 * (notably some SSH multiplexers) emit a stray byte or two after the raw-
 * mode flip that nudges the cursor. Reading the actual starting column
 * is one extra round-trip but ~100% reliable.
 *
 * **Falls back to `null`** on:
 *   - non-TTY stdin/stdout
 *   - inside tmux/screen (multiplexer state machines + our raw probe
 *     don't mix predictably; same conservative stance as
 *     `detectSynchronizedOutput`)
 *   - timeout (default 120ms; longer than DECRPM because the glyph
 *     write + second CPR adds one render frame)
 *   - parse failure
 *
 * @module nerd-glyph-width
 */

/** Cell width values we accept. The visible Nerd Font universe is 1 or 2. */
export type NerdGlyphCells = 1 | 2

/**
 * Layout-policy cell width of an icon, reading ONLY the first codepoint.
 *
 * Returns `1` or `2` -- the two regimes the status-row gap formula cares
 * about. Used by:
 *   - {@link import("./live-area-status.ts").LiveAreaStatusController.paint}
 *     to size the gap between icon and label (1 ASCII space for narrow,
 *     2 ASCII spaces for wide PUA).
 *   - {@link import("./spinner/blinking-nerd.ts").BlinkingNerdSpinner.render}
 *     to populate the `iconCells` hint on every frame so paint stays
 *     stable across the on/off blink cycle.
 *
 * Strips a leading SGR escape so a colorized icon resolves to its
 * underlying glyph. For multi-codepoint icons (e.g. "NET" — an unusual
 * but valid choice for ASCII spinners), this returns the FIRST
 * codepoint's class, which is what we want: a 3-cell ASCII spinner
 * still gets a 1-space gap (it's a "narrow text run", not a "wide
 * glyph"). For the actual rendered string width — used by the spinner's
 * off-frame to size its whitespace pad — see {@link effectiveDisplayWidth}.
 */
export function visualCellsForGlyph(text: string): NerdGlyphCells {
  const clean = text.replace(ANSI_STRIP_RE, "")
  if (clean.length === 0) return 1
  const cp = clean.codePointAt(0)
  if (cp === undefined) return 1
  return codePointVisualCells(cp) === 2 ? 2 : 1
}

/**
 * Total visual cell width of a rendered string, PUA-aware.
 *
 * Like {@link import("./term-width.ts").displayWidth} but:
 *   - PUA codepoints (Nerd Font range) contribute the *probed* width
 *     (`getNerdGlyphCells()`) instead of the static `1` from
 *     `term-width.ts`.
 *   - All other codepoint classes (combining, wide, narrow, control)
 *     match `displayWidth` exactly.
 *
 * Used by `BlinkingNerdSpinner.render` to emit an off-frame whitespace
 * pad of the same VISIBLE width as the on-frame icon, so the label
 * column doesn't jiggle on blink regardless of icon shape (single PUA
 * glyph, ASCII multi-char like "NET", CJK fullwidth, etc.).
 */
export function effectiveDisplayWidth(text: string): number {
  const clean = text.replace(ANSI_STRIP_RE, "")
  let total = 0
  for (let i = 0; i < clean.length; ) {
    const cp = clean.codePointAt(i)
    if (cp === undefined) break
    total += codePointVisualCells(cp)
    i += cp > 0xffff ? 2 : 1
  }
  return total
}

/**
 * Cell width of a single codepoint, with PUA reading the probed value.
 * Shared inline-width logic for {@link visualCellsForGlyph} and
 * {@link effectiveDisplayWidth}.
 */
function codePointVisualCells(cp: number): number {
  // Control / zero-width.
  if (cp < 0x20 || cp === 0x7f) return 0
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining marks
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) ||
    cp === 0x2060 ||
    cp === 0xfeff ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0
  }
  // Private Use Areas (PUA-A = E000..F8FF, PUA-B = F0000..FFFFD,
  // F-PUA-B = 100000..10FFFD). Nerd Font glyphs live here -- use the
  // probed value, not the static UAX classification.
  if (
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xf0000 && cp <= 0xffffd) ||
    (cp >= 0x100000 && cp <= 0x10fffd)
  ) {
    return cached
  }
  // UAX-style wide ranges: CJK, hangul, emoji.
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f700 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

const ANSI_STRIP_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

export interface ProbeInput {
  isTTY?: boolean
  setRawMode?(mode: boolean): unknown
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown
  resume?(): unknown
  pause?(): unknown
}

export interface ProbeOutput {
  isTTY?: boolean
  write(chunk: string): boolean | void
}

export interface ProbeResult {
  /** Detected cell width, or `null` if the probe couldn't run / timed out. */
  cells: NerdGlyphCells | null
  /**
   * Bytes read from stdin during the probe that were NOT part of CPR
   * replies. Forward these to the next stdin consumer (typically the
   * editor) so a typeahead keystroke isn't lost.
   */
  unparsed: string
}

export interface ProbeOptions {
  /**
   * Sample Nerd Font glyph to measure. Defaults to U+F1064 (nf-md-tools,
   * `󱁤`). All PUA glyphs in a given Nerd Font render at the same width
   * in practice, so any of them works as the probe sample. The default
   * is retained even though `tool.running` no longer uses NF_TOOLS
   * (swapped to `▸` to avoid the width-ambiguity headache) — the result
   * still applies to `auth.refresh` (NF_LOCK is PUA) and any future PUA
   * icon swap-in.
   */
  sample?: string
  /**
   * Max ms to wait for both CPR replies. Default 120ms. The CPR query +
   * glyph write + second CPR query is ~one render frame on local TTYs;
   * on a slow remote shell we want to wait a bit longer than the 80ms
   * DECRPM probe but not block startup visibly.
   */
  timeoutMs?: number
  /**
   * If true, the probe assumes the caller already has stdin in raw mode
   * and will NOT touch `setRawMode`. Useful when chaining with another
   * probe (e.g. `detectSynchronizedOutput`) that already raw'd stdin.
   * Default false.
   */
  alreadyRaw?: boolean
}

const CPR_RE = /\x1b\[(\d+);(\d+)R/

let cached: NerdGlyphCells = 1
let cacheExplicit = false

/**
 * Current best-known visual cell width for a sample Nerd Font glyph.
 *
 * Returns the cached value (default `1`) when the probe hasn't run or
 * the user hasn't set an override. Renderers that need to position
 * content relative to a PUA glyph should read this, not
 * {@link import("./term-width.ts").displayWidth}, which always
 * returns `1` for PUA codepoints regardless of font config.
 */
export function getNerdGlyphCells(): NerdGlyphCells {
  return cached
}

/**
 * Manually set the cached cell width. Used by:
 *   - the probe's successful resolution (`probeNerdGlyphCells`)
 *   - the config/env-override path in `src/index.ts`
 *   - tests that want a deterministic value.
 */
export function setNerdGlyphCells(cells: NerdGlyphCells): void {
  cached = cells
  cacheExplicit = true
}

/**
 * True once any of `probeNerdGlyphCells`, `setNerdGlyphCells`, or a
 * config-override path has run. Lets the wiring code in `index.ts`
 * decide whether to actually run the probe (skipping it when the user
 * already specified the value).
 */
export function nerdGlyphCellsIsExplicit(): boolean {
  return cacheExplicit
}

/**
 * Reset the cache to the default (`1`). Test-only escape hatch.
 *
 * @internal
 */
export function _resetNerdGlyphCellsForTest(): void {
  cached = 1
  cacheExplicit = false
}

/**
 * Probe the terminal for the visual cell width of a Nerd Font glyph.
 *
 * Sets the module cache on success. Caller may also read the result
 * directly from the returned `ProbeResult.cells`.
 *
 * Skipped (returns `{cells: null, unparsed: ""}`) when stdin or stdout
 * is not a TTY, when we're inside a multiplexer, or when the user
 * explicitly set the cell width via `setNerdGlyphCells`.
 */
export async function probeNerdGlyphCells(
  input: ProbeInput,
  output: ProbeOutput,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  if (!input.isTTY || !output.isTTY) {
    return { cells: null, unparsed: "" }
  }
  const insideMultiplexer =
    !!process.env.TMUX || !!process.env.STY || /^(screen|tmux)/.test(process.env.TERM ?? "")
  if (insideMultiplexer) {
    return { cells: null, unparsed: "" }
  }

  const sample = opts.sample ?? "\u{F1064}"
  const timeoutMs = opts.timeoutMs ?? 120

  let buf = ""
  let col0: number | null = null
  let col1: number | null = null

  let resolveDone: ((r: ProbeResult) => void) | null = null
  const done = new Promise<ProbeResult>((r) => {
    resolveDone = r
  })

  const finish = (cells: NerdGlyphCells | null): void => {
    // Strip both CPR replies (and only those) from buf so callers don't
    // see them as typeahead. Anything else the user typed survives.
    let unparsed = buf
    let m: RegExpMatchArray | null
    while ((m = CPR_RE.exec(unparsed))) {
      const idx = m.index ?? 0
      unparsed = unparsed.slice(0, idx) + unparsed.slice(idx + m[0].length)
    }
    if (cells != null) setNerdGlyphCells(cells)
    resolveDone?.({ cells, unparsed })
  }

  const onData = (chunk: Buffer | string): void => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    // Process CPR replies in order. Each match consumes its bytes from buf.
    while (true) {
      const m = buf.match(CPR_RE)
      if (!m) return
      const col = Number(m[2])
      buf = buf.slice(0, m.index ?? 0) + buf.slice((m.index ?? 0) + m[0].length)
      if (col0 == null) {
        col0 = col
        // We have the baseline column. Print the glyph then re-query.
        output.write(`${sample}\x1b[6n`)
      } else if (col1 == null) {
        col1 = col
        // Restore: move cursor to column 1, erase to end of line so the
        // glyph artifact (visible for a few ms) is wiped before the
        // editor mounts.
        output.write("\r\x1b[K")
        const delta = col1 - col0
        const cells: NerdGlyphCells | null = delta === 1 ? 1 : delta === 2 ? 2 : null
        finish(cells)
        return
      }
    }
  }

  const hadRaw = !opts.alreadyRaw && typeof input.setRawMode === "function"
  if (hadRaw) input.setRawMode?.(true)
  input.resume?.()
  input.on("data", onData)

  // Kick off: move to known column (1) then ask for cursor position.
  // We can't trust the "starting" column because something between the
  // previous render and now (e.g. typeahead echoes from a wedged
  // terminal) may have nudged it. The `\r` gives us a deterministic
  // baseline AT cell 1, then CPR confirms.
  output.write("\r\x1b[6n")

  const timer = setTimeout(() => {
    // Best-effort cleanup: write the restore sequence so any partially-
    // drawn glyph gets wiped even on timeout.
    output.write("\r\x1b[K")
    finish(null)
  }, timeoutMs)

  const result = await done
  clearTimeout(timer)
  input.off("data", onData)
  // Leave raw-mode toggling to the caller (matches the convention in
  // `detectSynchronizedOutput`).
  return result
}

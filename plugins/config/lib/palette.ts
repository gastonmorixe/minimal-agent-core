/**
 * Local SGR shortcuts for the config overlay.
 *
 * Mirrors the colors in minimal-agent's `src/palette.ts` so the overlay
 * renders in the same visual family, but kept as raw byte strings here so
 * the plugin's `lib/` stays a pure, host-free, standalone-testable unit.
 * (Same decoupling pattern as `ma-slash-menu-plugin/lib/palette.ts`.)
 *
 * @module config/lib/palette
 */

export const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  // Modern "Cool Summer" palette (synced with src/palette.ts).
  pink: "\x1b[38;5;199m",
  lime: "\x1b[38;5;118m",
  sky: "\x1b[38;5;45m",
  violet: "\x1b[38;2;180;140;255m",
  gold: "\x1b[38;5;214m",
  orange: "\x1b[38;5;208m",
  purple: "\x1b[38;5;98m",
  // Standard.
  red: "\x1b[31m",
  brightRed: "\x1b[91m",
  white: "\x1b[37m",
  faintWhite: "\x1b[2;37m",
  boldWhite: "\x1b[1;37m",
  // Dim / bold variants for headers + emphasis.
  dimLime: "\x1b[2;38;5;118m",
  dimSky: "\x1b[2;38;5;45m",
  dimGold: "\x1b[2;38;5;214m",
  dimRed: "\x1b[2;31m",
  dimViolet: "\x1b[2;38;2;180;140;255m",
  boldSky: "\x1b[1;38;5;45m",
  boldLime: "\x1b[1;38;5;118m",
  boldRed: "\x1b[1;91m",
  boldGold: "\x1b[1;38;5;214m",
  boldPink: "\x1b[1;38;5;199m",
} as const

/** Wrap text in an SGR open + reset, with a guard for empty strings. */
export function wrap(text: string, sgr: string): string {
  if (text === "") return ""
  return `${sgr}${text}${SGR.reset}`
}

/** Wrap with dim. */
export function dim(text: string): string {
  return wrap(text, SGR.dim)
}

/** Strip SGR escapes — needed for visual-width math + tests. */
export function stripSgr(s: string): string {
  // ESC = U+001B; intentional control char to match real ANSI streams.
  return s.replace(/\u001b\[[\d;]*m/g, "")
}

/** Visible cell width (ASCII-only content; good enough for our rows). */
export function visualWidth(s: string): number {
  return stripSgr(s).length
}

/** Right-pad to `width` visible cells. */
export function padRight(s: string, width: number, padChar = " "): string {
  const w = visualWidth(s)
  if (w >= width) return s
  return s + padChar.repeat(width - w)
}

/** Truncate to `maxWidth` visible cells with an ellipsis. ANSI-naive: only
 *  call on plain (un-wrapped) text. */
export function truncate(s: string, maxWidth: number): string {
  if (visualWidth(s) <= maxWidth) return s
  if (maxWidth <= 1) return "…"
  return s.slice(0, maxWidth - 1) + "…"
}

/**
 * Truncate an ANSI-bearing string to `maxCells` visible width, keeping SGR
 * sequences intact (no half-escapes). Final safety clamp on overlay rows so
 * a wide value never wraps the live area.
 */
export function truncateVisible(s: string, maxCells: number): string {
  if (maxCells <= 0) return ""
  let out = ""
  let cells = 0
  let i = 0
  while (i < s.length) {
    if (s[i] === "\u001b") {
      const end = s.indexOf("m", i)
      if (end < 0) break
      out += s.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (cells >= maxCells) break
    out += s[i]
    cells++
    i++
  }
  return out
}

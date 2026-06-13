/**
 * Config overlay style facade.
 *
 * This module keeps the renderer's local names stable while sourcing ANSI,
 * palette, and display-width behavior from the shared plugin API. The plugin
 * remains host-free: it depends on the contract package, not `src/ui/*`.
 *
 * @module config/lib/palette
 */

import { ANSI_CODES, color } from "@minimal-agent/plugin-api/utils/ansi"
import { PALETTE } from "@minimal-agent/plugin-api/utils/palette"
import {
  displayWidth,
  stripAnsi,
  truncateDisplayWidth,
} from "@minimal-agent/plugin-api/utils/term-width"

export const SGR = {
  reset: ANSI_CODES.RESET,
  bold: ANSI_CODES.BOLD,
  dim: ANSI_CODES.DIM,
  italic: ANSI_CODES.ITALIC,
  underline: ANSI_CODES.UNDERLINE,
  pink: PALETTE.pink,
  lime: PALETTE.lime,
  sky: PALETTE.sky,
  violet: PALETTE.violet,
  gold: PALETTE.gold,
  orange: PALETTE.orange,
  purple: PALETTE.purple,
  // Standard.
  red: PALETTE.red,
  brightRed: PALETTE.brightRed,
  white: PALETTE.white,
  faintWhite: ANSI_CODES.FAINT_WHITE,
  boldWhite: ANSI_CODES.BOLD_WHITE,
  // Dim / bold variants for headers + emphasis.
  dimLime: ANSI_CODES.DIM_LIME,
  dimSky: ANSI_CODES.DIM_SKY,
  dimGold: ANSI_CODES.DIM_GOLD,
  dimRed: ANSI_CODES.DIM_RED,
  dimViolet: ANSI_CODES.DIM_VIOLET,
  boldSky: ANSI_CODES.BOLD_SKY,
  boldLime: ANSI_CODES.BOLD_LIME,
  boldRed: ANSI_CODES.BOLD_BRIGHT_RED,
  boldGold: ANSI_CODES.BOLD_GOLD,
  boldPink: ANSI_CODES.BOLD_PINK,
} as const

/** Wrap text in an SGR open + reset, with a guard for empty strings. */
export function wrap(text: string, sgr: string): string {
  if (text === "") return ""
  return color(true, sgr, text)
}

/** Wrap with dim. */
export function dim(text: string): string {
  return wrap(text, SGR.dim)
}

/** Strip SGR escapes — needed for visual-width math + tests. */
export function stripSgr(s: string): string {
  return stripAnsi(s)
}

/** Visible cell width using the shared terminal-width model. */
export function visualWidth(s: string): number {
  return displayWidth(s)
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
  return truncateDisplayWidth(s, maxWidth, "…")
}

/**
 * Truncate an ANSI-bearing string to `maxCells` visible width, keeping SGR
 * sequences intact (no half-escapes). Final safety clamp on overlay rows so
 * a wide value never wraps the live area.
 */
export function truncateVisible(s: string, maxCells: number): string {
  return truncateDisplayWidth(s, maxCells, "")
}

/**
 * Shared ANSI wrapper helpers for host and plugin TUI renderers.
 *
 * The palette tokens live in {@link PALETTE}. This module owns the tiny,
 * byte-stable wrapping policy around those tokens so plugins do not hand-roll
 * subtly different `dim`, `bold`, or foreground reset helpers.
 *
 * Pure and dependency-free: no TTY probing, no env reads, no host imports.
 *
 * @module ansi
 */

import { FG_RESET, PALETTE } from "./palette.ts"

export type AnsiWrapper = (s: string) => string

/** Raw SGR open/close constants for renderers that need explicit reset control. */
export const ANSI_CODES = {
  RESET: "\x1b[0m",
  FG_RESET,
  BG_RESET: "\x1b[49m",
  ERASE_LINE: "\x1b[2K",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  ITALIC: "\x1b[3m",
  UNDERLINE: "\x1b[4m",
  STRIKE: "\x1b[9m",
  BOLD_CLOSE: "\x1b[22m",
  DIM_CLOSE: "\x1b[22m",
  ITALIC_CLOSE: "\x1b[23m",
  UNDERLINE_CLOSE: "\x1b[24m",
  STRIKE_CLOSE: "\x1b[29m",
  BRIGHT_BLACK: "\x1b[90m",
  DARK_GRAY: "\x1b[38;5;240m",
  LIGHT_GRAY: "\x1b[38;5;246m",
} as const

/** Truecolor background SGR open sequence. */
export function bgRgb(r: number, g: number, b: number): string {
  return `\x1b[48;2;${r};${g};${b}m`
}

/** Wrap with an arbitrary open + close sequence. */
export const attr = (open: string, close: string): AnsiWrapper => {
  return (s: string) => `${open}${s}${close}`
}

/** Wrap with a foreground SGR open sequence and close foreground only. */
export const fg = (open: string): AnsiWrapper => {
  return attr(open, FG_RESET)
}

/** Wrap a compound open sequence with its explicit compound close. */
export const combo = (open: string, close: string): AnsiWrapper => {
  return attr(open, close)
}

/** Conditionally wrap text in raw SGR codes, closing with a full reset. */
export function color(ansi: boolean, codes: string, text: string): string {
  return ansi ? `${codes}${text}${ANSI_CODES.RESET}` : text
}

/**
 * Common style helpers shared by the host TUI and plugin renderers. These are
 * intentionally byte-compatible with the long-standing `c.*` helper surface.
 */
export const ansiStyle = {
  dim: attr(ANSI_CODES.DIM, ANSI_CODES.DIM_CLOSE),
  cyan: fg(PALETTE.cyan),
  blue: fg(PALETTE.blue),
  magenta: fg(PALETTE.magenta),
  yellow: fg(PALETTE.yellow),
  green: fg(PALETTE.green),
  red: fg(PALETTE.red),
  white: fg(PALETTE.white),
  gray: fg(ANSI_CODES.BRIGHT_BLACK),
  bold: attr(ANSI_CODES.BOLD, ANSI_CODES.BOLD_CLOSE),
  italic: attr(ANSI_CODES.ITALIC, ANSI_CODES.ITALIC_CLOSE),
  underline: attr(ANSI_CODES.UNDERLINE, ANSI_CODES.UNDERLINE_CLOSE),
  brightCyan: fg(PALETTE.brightCyan),
  brightYellow: fg(PALETTE.brightYellow),
  brightGreen: fg(PALETTE.brightGreen),
  brightRed: fg(PALETTE.brightRed),
  brightMagenta: fg(PALETTE.brightMagenta),
  boldCyan: combo("\x1b[1;36m", "\x1b[22;39m"),
  boldGreen: combo("\x1b[1;32m", "\x1b[22;39m"),
  boldRed: combo("\x1b[1;31m", "\x1b[22;39m"),
  boldYellow: combo("\x1b[1;33m", "\x1b[22;39m"),
  boldWhite: combo("\x1b[1;37m", ANSI_CODES.RESET),
  boldBrightWhite: combo("\x1b[1;97m", "\x1b[22;39m"),
  dimCyan: combo("\x1b[2;36m", "\x1b[22;39m"),
  dimRed: combo("\x1b[2;31m", "\x1b[22;39m"),
  dimViolet: combo("\x1b[2;38;2;180;140;255m", "\x1b[22;39m"),
  faintWhite: combo("\x1b[2;37m", "\x1b[22;39m"),
  strike: attr(ANSI_CODES.STRIKE, ANSI_CODES.STRIKE_CLOSE),
  orange: fg(PALETTE.orange),
  pink: fg(PALETTE.pink),
  purple: fg(PALETTE.purple),
  lime: fg(PALETTE.lime),
  sky: fg(PALETTE.sky),
  violet: fg(PALETTE.violet),
  gold: fg(PALETTE.gold),
} as const

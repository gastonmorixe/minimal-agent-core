/**
 * Palette library — ANSI colorizers and ready-made palettes for spinners.
 *
 * Each colorizer is a `(text) => string` that wraps its argument in a
 * minimal ANSI SGR sequence and resets at the end. Palettes are
 * `readonly Colorizer[]` so spinners can rotate through them per frame.
 *
 * @module spinner/library/palettes
 */

import type { Colorizer } from "../types.ts"

// ─── Single-color colorizers (basic ANSI 16-color, foreground) ──────────────

export const ansiCyan: Colorizer = (t) => `\x1b[36m${t}\x1b[39m`
export const ansiBlue: Colorizer = (t) => `\x1b[34m${t}\x1b[39m`
export const ansiMagenta: Colorizer = (t) => `\x1b[35m${t}\x1b[39m`
export const ansiGreen: Colorizer = (t) => `\x1b[32m${t}\x1b[39m`
export const ansiYellow: Colorizer = (t) => `\x1b[33m${t}\x1b[39m`
export const ansiRed: Colorizer = (t) => `\x1b[31m${t}\x1b[39m`
export const ansiWhite: Colorizer = (t) => `\x1b[37m${t}\x1b[39m`
export const ansiDim: Colorizer = (t) => `\x1b[2m${t}\x1b[22m`
export const ansiBold: Colorizer = (t) => `\x1b[1m${t}\x1b[22m`

// ─── Palettes ───────────────────────────────────────────────────────────────

/** Default rotating palette — cyan → blue → magenta → green → yellow. */
export const ANSI_PALETTE_RAINBOW: readonly Colorizer[] = [
  ansiCyan,
  ansiBlue,
  ansiMagenta,
  ansiGreen,
  ansiYellow,
]

/** Cool palette — calmer, no warm hues. */
export const ANSI_PALETTE_COOL: readonly Colorizer[] = [ansiCyan, ansiBlue, ansiMagenta]

/** Warm palette — sun colors. */
export const ANSI_PALETTE_WARM: readonly Colorizer[] = [
  ansiYellow,
  (t) => `\x1b[38;5;208m${t}\x1b[39m`, // orange
  ansiRed,
]

/** Monochrome — single color, no rotation. */
export const ANSI_PALETTE_MONO_CYAN: readonly Colorizer[] = [ansiCyan]
export const ANSI_PALETTE_MONO_DIM: readonly Colorizer[] = [ansiDim]

/** Breathing palette — fades dim→normal→bold→normal→dim, single hue. */
export const ANSI_PALETTE_BREATHE_CYAN: readonly Colorizer[] = [
  (t) => `\x1b[2;36m${t}\x1b[22;39m`,
  (t) => `\x1b[36m${t}\x1b[39m`,
  (t) => `\x1b[1;36m${t}\x1b[22;39m`,
  (t) => `\x1b[36m${t}\x1b[39m`,
]

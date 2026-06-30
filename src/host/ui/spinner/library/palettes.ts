/**
 * Palette library — ANSI colorizers and ready-made palettes for spinners.
 *
 * Each colorizer is a `(text) => string` that wraps its argument in a
 * minimal ANSI SGR sequence and resets at the end. Palettes are
 * `readonly Colorizer[]` so spinners can rotate through them per frame.
 *
 * @module spinner/library/palettes
 */

import { ansiStyle as c } from "@minimal-agent/plugin-api/utils/ansi"

import type { Colorizer } from "../types.ts"

// ─── Single-color colorizers (basic ANSI 16-color, foreground) ──────────────

export const ansiCyan: Colorizer = c.cyan
export const ansiBlue: Colorizer = c.blue
export const ansiMagenta: Colorizer = c.magenta
export const ansiGreen: Colorizer = c.green
export const ansiYellow: Colorizer = c.yellow
export const ansiRed: Colorizer = c.red
export const ansiWhite: Colorizer = c.white
export const ansiDim: Colorizer = c.dim
export const ansiBold: Colorizer = c.bold

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
export const ANSI_PALETTE_WARM: readonly Colorizer[] = [ansiYellow, c.orange, ansiRed]

/** Monochrome — single color, no rotation. */
export const ANSI_PALETTE_MONO_CYAN: readonly Colorizer[] = [ansiCyan]
export const ANSI_PALETTE_MONO_DIM: readonly Colorizer[] = [ansiDim]

/** Breathing palette — fades dim→normal→bold→normal→dim, single hue. */
export const ANSI_PALETTE_BREATHE_CYAN: readonly Colorizer[] = [
  c.dimCyan,
  c.cyan,
  c.boldCyan,
  c.cyan,
]

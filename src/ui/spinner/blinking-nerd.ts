/**
 * BlinkingNerdSpinner — single spinner that resolves an icon (static or
 * animated) per notification id / category, then renders it either as a
 * blink (static glyph on/off) or as a frame rotor (animated icon).
 *
 * The notification → icon map is the routing surface. To swap a single
 * icon, pass `iconByNotificationId: { "agent.thinking": "○" }`. To swap to
 * an animated rotor, pass `{ "agent.thinking": THINKING_ROTOR_ASCII }` from
 * the {@link library} module.
 *
 * @module ui/spinner/blinking-nerd
 */

import { effectiveDisplayWidth, visualCellsForGlyph } from "../../nerd-glyph-width.ts"

import { ANSI_PALETTE_RAINBOW } from "./library/palettes.ts"
import {
  DEFAULT_ICON_BY_CATEGORY,
  DEFAULT_ICON_BY_NOTIFICATION_ID,
  DEFAULT_NERD_ICON,
} from "./presets.ts"
import type {
  Colorizer,
  IconSpec,
  Spinner,
  SpinnerRenderContext,
  SpinnerRenderFrame,
} from "./types.ts"
import { isAnimatedIcon } from "./types.ts"

const DEFAULT_BLINK_MS = 500

export interface BlinkingNerdSpinnerTheme {
  blinkMs?: number
  colorizers?: readonly Colorizer[]
  defaultIcon?: IconSpec
  iconByNotificationId?: Record<string, IconSpec>
  iconByCategory?: Record<string, IconSpec>
}

export interface BlinkingNerdSpinnerOptions {
  blinkMs?: number
  colorizers?: readonly Colorizer[]
  defaultIcon?: IconSpec
  iconByNotificationId?: Record<string, IconSpec>
  iconByCategory?: Record<string, IconSpec>
}

/**
 * The default status spinner: a Nerd Font icon that blinks on a fixed period
 * and cycles through a color palette. The icon is picked per status
 * notification (by notification id, then category, then the default), so a
 * Bash call and a Fetch call animate with different glyphs.
 */
export class BlinkingNerdSpinner implements Spinner<BlinkingNerdSpinnerTheme> {
  readonly preferredFps: number
  private readonly blinkMs: number
  private readonly colorizers: readonly Colorizer[]
  private readonly defaultIcon: IconSpec
  private readonly iconByNotificationId: Readonly<Record<string, IconSpec>>
  private readonly iconByCategory: Readonly<Record<string, IconSpec>>

  constructor(opts?: BlinkingNerdSpinnerOptions) {
    this.blinkMs =
      typeof opts?.blinkMs === "number" && opts.blinkMs > 0 ? opts.blinkMs : DEFAULT_BLINK_MS
    this.preferredFps = 1000 / this.blinkMs
    this.colorizers =
      opts?.colorizers && opts.colorizers.length > 0 ? [...opts.colorizers] : ANSI_PALETTE_RAINBOW
    this.defaultIcon = opts?.defaultIcon ?? DEFAULT_NERD_ICON
    this.iconByNotificationId = {
      ...DEFAULT_ICON_BY_NOTIFICATION_ID,
      ...(opts?.iconByNotificationId ?? {}),
    }
    this.iconByCategory = {
      ...DEFAULT_ICON_BY_CATEGORY,
      ...(opts?.iconByCategory ?? {}),
    }
  }

  render(context: SpinnerRenderContext<BlinkingNerdSpinnerTheme>): SpinnerRenderFrame {
    const spec = this.resolveIcon(context)
    const palette =
      context.theme.colorizers && context.theme.colorizers.length > 0
        ? context.theme.colorizers
        : this.colorizers

    if (isAnimatedIcon(spec)) {
      const interval = spec.intervalMs > 0 ? spec.intervalMs : DEFAULT_BLINK_MS
      const step = Math.floor(context.elapsedMs / interval)
      const frame = spec.frames[step % spec.frames.length] ?? ""
      const colorIndex = spec.steadyColor
        ? Math.floor(step / Math.max(1, spec.frames.length))
        : step
      const colorizer = palette.length > 0 ? palette[colorIndex % palette.length] : undefined
      const glyph = typeof colorizer === "function" ? colorizer(frame) : frame
      // Animated rotor frames are uniformly narrow (Braille U+28xx,
      // ASCII spinners, etc.) — report 1 cell unconditionally. If we
      // ever ship a 2-cell animated rotor, derive this from
      // `visualCellsForGlyph(frame)` instead.
      return { glyph, requestedFps: 1000 / interval, iconCells: 1 }
    }

    const blinkMs =
      typeof context.theme.blinkMs === "number" && context.theme.blinkMs > 0
        ? context.theme.blinkMs
        : this.blinkMs
    const step = Math.floor(context.elapsedMs / blinkMs)
    const requestedFps = 1000 / blinkMs
    // True blink: on-step renders the glyph in the rotating palette
    // color; off-step replaces it with whitespace of equivalent cell
    // width. The visible cycle reads as
    //   [color0, blank, color1, blank, color2, blank, …]
    // which is the appearance most users expect from a "blinking"
    // status indicator.
    //
    // Off-frame width matches the on-frame icon's visual cell count via
    // `visualCellsForGlyph`. For BMP-narrow icons (●, U+25CF) and
    // Braille rotor frames it returns 1. For PUA Nerd Font glyphs
    // (`󱁤`, `󰌾`, …) it returns the value detected by `probeNerdGlyphCells`
    // at startup (1 for unpatched fallback fonts, 2 for patched Nerd
    // Fonts) — so the label column stays put on every blink instead of
    // jiggling 1 cell with the icon's real width on the on-frame and
    // its `displayWidth` model width on the off-frame.
    // TWO width concepts in play, each serving a distinct purpose:
    //
    //   - `padCells` = total visible cell count of the spec across all
    //     codepoints, PUA-aware. Drives the off-frame whitespace pad so
    //     it occupies the same number of columns as the on-frame icon
    //     (e.g. ASCII "NET" = 3, single PUA glyph in patched font = 2,
    //     `●` = 1). Keeps the LABEL column stable on every blink.
    //
    //   - `iconCells` = 1 or 2 layout-policy class of the FIRST
    //     codepoint. Hands to the live-area status paint path so it can pick
    //     the gap width (1 ASCII space for narrow / multi-char ASCII,
    //     2 ASCII spaces for wide PUA / wide UAX glyphs). Stays the
    //     SAME value across on/off frames.
    const padCells = Math.max(1, effectiveDisplayWidth(spec))
    const iconCells = visualCellsForGlyph(spec)

    if (step % 2 !== 0) {
      return { glyph: " ".repeat(padCells), requestedFps, iconCells }
    }

    // Color advances ONCE per on/off cycle so the visible sequence is
    // [color0, dim, color1, dim, color2, dim, …] — every palette entry
    // gets its turn. Using `step % len` directly would skip odd-indexed
    // entries (only even `step`s reach here), producing
    // [color0, dim, color2, dim, color4, dim, color1, …] — entries are
    // visited but not in declared order, which reads as "random colors"
    // instead of a clean rainbow walk.
    const colorIndex = Math.floor(step / 2)
    const colorizer = palette.length > 0 ? palette[colorIndex % palette.length] : undefined
    const glyph = typeof colorizer === "function" ? colorizer(spec) : spec
    return { glyph, requestedFps, iconCells }
  }

  private resolveIcon(context: SpinnerRenderContext<BlinkingNerdSpinnerTheme>): IconSpec {
    const notificationId = context.notification.notificationId
    if (notificationId && this.iconByNotificationId[notificationId]) {
      return this.iconByNotificationId[notificationId]
    }
    const category = context.notification.category
    if (category && this.iconByCategory[category]) {
      return this.iconByCategory[category]
    }
    return context.theme.defaultIcon ?? this.defaultIcon
  }
}

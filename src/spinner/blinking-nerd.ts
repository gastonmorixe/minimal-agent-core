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
 * @module spinner/blinking-nerd
 */

import type {
  Colorizer,
  IconSpec,
  Spinner,
  SpinnerRenderContext,
  SpinnerRenderFrame,
} from "./types.ts"
import { isAnimatedIcon } from "./types.ts"
import {
  DEFAULT_ICON_BY_NOTIFICATION_ID,
  DEFAULT_ICON_BY_CATEGORY,
  DEFAULT_NERD_ICON,
} from "./presets.ts"
import { ANSI_PALETTE_RAINBOW } from "./library/palettes.ts"

const DEFAULT_BLINK_MS = 300

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
      return { glyph, requestedFps: 1000 / interval }
    }

    const blinkMs =
      typeof context.theme.blinkMs === "number" && context.theme.blinkMs > 0
        ? context.theme.blinkMs
        : this.blinkMs
    const step = Math.floor(context.elapsedMs / blinkMs)
    const requestedFps = 1000 / blinkMs
    if (step % 2 !== 0) return { glyph: " ", requestedFps }

    const colorizer = palette.length > 0 ? palette[step % palette.length] : undefined
    const glyph = typeof colorizer === "function" ? colorizer(spec) : spec
    return { glyph, requestedFps }
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

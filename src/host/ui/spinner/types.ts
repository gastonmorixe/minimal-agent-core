/**
 * Spinner contract — types shared by every spinner implementation and the
 * {@link SpinnerManager}.
 *
 * Two render modes per icon entry are supported via {@link IconSpec}:
 *
 * - **string** — single static glyph rendered with on/off blink behavior
 *   (controlled by `BlinkingNerdSpinnerTheme.blinkMs`).
 * - **{@link AnimatedIcon}** — frame sequence rendered at a fixed interval.
 *   The renderer asks the manager for `1000 / intervalMs` fps so different
 *   notifications can run at different rates from the same spinner instance.
 *
 * @module spinner/types
 */

/** A single rendered frame returned by `Spinner.render`. */
export interface SpinnerRenderFrame {
  glyph: string
  /**
   * Frames-per-second the spinner wants for the *next* tick. The manager
   * clamps this against its `maxFps`. Omit to keep the previously
   * negotiated rate.
   */
  requestedFps?: number
  /**
   * Visual cell width of the *canonical icon* this frame represents.
   * Both on-frame and off-frame should report the SAME value so the
   * downstream layout (e.g. live-area status row gap-after-glyph) stays
   * stable across the blink cycle. Without this, renderers fall back to
   * inspecting `glyph` — which mis-counts cells for PUA Nerd Font glyphs
   * (`displayWidth` returns 1, real visual is 1 or 2 depending on font)
   * AND for off-frame whitespace pads (glyph is " ", visual is whatever
   * the on-frame was). Optional for back-compat; absent = renderer
   * falls back to its own heuristic.
   */
  iconCells?: 1 | 2
}

/** Coarse routing key — used by spinners to pick an icon / frame set. */
export interface SpinnerNotification {
  notificationId?: string
  category?: string
}

export interface SpinnerLifecycleContext<TTheme = unknown> {
  now: number
  startedAt: number
  theme: TTheme
  notification: SpinnerNotification
}

export interface SpinnerRenderContext<TTheme = unknown> extends SpinnerLifecycleContext<TTheme> {
  elapsedMs: number
  maxFps: number
  currentFps: number
}

export interface SpinnerWillDisappearContext<TTheme = unknown>
  extends SpinnerLifecycleContext<TTheme> {
  maxGraceMs: number
}

export interface SpinnerThemeChangeContext<TTheme = unknown>
  extends SpinnerLifecycleContext<TTheme> {
  previousTheme: TTheme
  nextTheme: TTheme
}

export interface SpinnerNotificationChangeContext<TTheme = unknown>
  extends SpinnerLifecycleContext<TTheme> {
  previousNotification: SpinnerNotification
  nextNotification: SpinnerNotification
}

export interface Spinner<TTheme = unknown> {
  preferredFps?: number
  willShow?(context: SpinnerLifecycleContext<TTheme>): void
  didShow?(context: SpinnerLifecycleContext<TTheme>): void
  render(context: SpinnerRenderContext<TTheme>): SpinnerRenderFrame
  willDisappear?(context: SpinnerWillDisappearContext<TTheme>): number | false | void
  didDisappear?(context: SpinnerLifecycleContext<TTheme>): void
  onThemeChange?(context: SpinnerThemeChangeContext<TTheme>): void
  onNotificationChange?(context: SpinnerNotificationChangeContext<TTheme>): void
}

/** Function signature used to colorize a glyph (typically wraps with ANSI). */
export type Colorizer = (text: string) => string

/**
 * Animated icon — a frame sequence rendered at `intervalMs` per frame.
 *
 * The rotor advances independently of the spinner's blink schedule, so
 * `agent.thinking` can spin fast (e.g. 130ms) while `tool.running` blinks
 * slowly (e.g. 300ms) from the same {@link BlinkingNerdSpinner} instance.
 */
export interface AnimatedIcon {
  frames: readonly string[]
  /** Per-frame interval in ms. Must be \> 0. */
  intervalMs: number
  /**
   * If `true`, the palette colorizer is held constant across all frames of
   * a single rotation cycle (one full revolution = `frames.length` ticks).
   * If `false` or omitted, the color advances every frame.
   */
  steadyColor?: boolean
}

/** Either a static glyph (blinks on/off) or an animated frame set. */
export type IconSpec = string | AnimatedIcon

/** Type guard separating animated frame-set icons from static single-glyph icons. */
export function isAnimatedIcon(spec: IconSpec): spec is AnimatedIcon {
  return typeof spec === "object" && Array.isArray((spec as AnimatedIcon).frames)
}

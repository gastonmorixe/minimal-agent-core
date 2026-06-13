/**
 * BrailleSpinner — frame-cycle spinner driven by `BRAILLE_DOTS` from the
 * library by default. Themable via `accent` to wrap each glyph with ANSI.
 *
 * @module spinner/braille
 */

import { BRAILLE_DOTS } from "./library/frames.ts"
import type { Spinner, SpinnerRenderContext, SpinnerRenderFrame } from "./types.ts"

export interface BrailleSpinnerTheme {
  accent?: (text: string) => string
}

/**
 * Classic braille-dot spinner: cycles a fixed frame set at a configurable
 * FPS, deriving the frame index purely from elapsed time so rendering stays
 * stateless and deterministic. The theme's optional `accent` colorizes the
 * glyph.
 */
export class BrailleSpinner implements Spinner<BrailleSpinnerTheme> {
  readonly preferredFps: number
  private readonly frames: string[]

  constructor(opts?: { fps?: number; frames?: readonly string[] }) {
    this.preferredFps = opts?.fps ?? 12
    this.frames = opts?.frames && opts.frames.length > 0 ? [...opts.frames] : [...BRAILLE_DOTS]
  }

  render(context: SpinnerRenderContext<BrailleSpinnerTheme>): SpinnerRenderFrame {
    const fps = this.preferredFps > 0 ? this.preferredFps : 1
    const idx = Math.floor((context.elapsedMs / 1000) * fps) % this.frames.length
    const frame = this.frames[idx] ?? this.frames[0] ?? "•"
    const accent = context.theme?.accent
    const glyph = typeof accent === "function" ? accent(frame) : frame
    return { glyph, requestedFps: this.preferredFps }
  }
}

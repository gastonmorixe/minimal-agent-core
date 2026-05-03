/**
 * Frame-set library — named, ready-to-use animated icon presets.
 *
 * Each export is either:
 *
 * - a `readonly string[]` (frames only — pair with your own `intervalMs`), or
 * - a full `AnimatedIcon` (frames + recommended interval), suffixed with
 *   the timing as a hint (e.g. `THINKING_ROTOR_ASCII` is the AnimatedIcon
 *   with the recommended 130ms interval).
 *
 * Rule of thumb for interval: pick the smallest value that *feels* alive
 * but doesn't cause flicker. 80–160ms is the sweet spot for most rotors;
 * 60–90ms for single-dot orbits; 200–300ms for breathing.
 *
 * @module spinner/library/frames
 */

import type { AnimatedIcon } from "../types.ts"

// ─── Bare frame sets (combine with your own intervalMs) ─────────────────────

/** Default Braille spinner used by `BrailleSpinner`. */
export const BRAILLE_DOTS: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** ASCII rotor — 4 frames. Visually wobbles slightly because `\` and `/`
 *  are narrower than `-` and `|` in many monospace fonts. */
export const ROTOR_ASCII: readonly string[] = ["-", "\\", "|", "/"]

/** Box-drawing rotor — same idea as ROTOR_ASCII but every glyph has the
 *  same visual weight, so no wobble. */
export const ROTOR_BOX: readonly string[] = ["─", "╲", "│", "╱"]

/** Single Braille dot orbiting the cell — calmer than the full Braille set. */
export const DOT_ORBIT_BRAILLE: readonly string[] = ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"]

/** Breathing dot — grows and shrinks. Use ~160ms. */
export const BREATHING_DOT: readonly string[] = ["·", "∙", "•", "●", "•", "∙"]

/** Vertical pulse bar (8 levels). */
export const PULSE_BAR: readonly string[] = ["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"]

/** Horizontal sweep (3 dots scrolling). */
export const SWEEP_DOTS: readonly string[] = ["   ", ".  ", ".. ", "...", " ..", "  ."]

/** Half-circle phase rotation (Unicode geometric shapes). */
export const PHASE_HALF: readonly string[] = ["◐", "◓", "◑", "◒"]

/** Quadrant rotation. */
export const PHASE_QUADRANT: readonly string[] = ["◴", "◷", "◶", "◵"]

/** Squareish "block" rotor — heavy, attention-grabbing. */
export const BLOCK_ROTOR: readonly string[] = ["▖", "▘", "▝", "▗"]

/** Triangle pointer rotation. */
export const TRIANGLE_POINTER: readonly string[] = ["◢", "◣", "◤", "◥"]

/** Bouncing ball between two brackets (5 positions × 2 directions). */
export const BOUNCING_BALL: readonly string[] = [
  "[●    ]",
  "[ ●   ]",
  "[  ●  ]",
  "[   ● ]",
  "[    ●]",
  "[   ● ]",
  "[  ●  ]",
  "[ ●   ]",
]

/** Arc corner sweep — four corners of a circle traced in sequence. */
export const ARC_SWEEP: readonly string[] = ["◜", "◝", "◞", "◟"]

/** Eight-point arrow compass orbit — directional, suits network/download ops. */
export const ARROW_ORBIT: readonly string[] = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"]

/** Circled-dot focus ring — calm pulse between filled and hollow. */
export const CIRCLE_PULSE: readonly string[] = ["◉", "◎", "○", "◌", "○", "◎"]

/** Heavy braille rotor — fills the cell, more visual weight than BRAILLE_DOTS. */
export const BRAILLE_ROTOR_HEAVY: readonly string[] = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"]

/** Grow-shrink block bar — semantically evokes download/transfer progress. */
export const BAR_GROW: readonly string[] = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█", "▉", "▊", "▋", "▌", "▍", "▎"]

// ─── Recommended AnimatedIcon bundles (frames + intervalMs) ─────────────────

export const THINKING_ROTOR_ASCII: AnimatedIcon = {
  frames: ROTOR_ASCII,
  intervalMs: 130,
}

export const THINKING_ROTOR_BOX: AnimatedIcon = {
  frames: ROTOR_BOX,
  intervalMs: 130,
}

export const THINKING_DOT_ORBIT: AnimatedIcon = {
  frames: DOT_ORBIT_BRAILLE,
  intervalMs: 90,
}

export const THINKING_BREATHING: AnimatedIcon = {
  frames: BREATHING_DOT,
  intervalMs: 160,
  steadyColor: true,
}

export const THINKING_PULSE: AnimatedIcon = {
  frames: PULSE_BAR,
  intervalMs: 80,
  steadyColor: true,
}

export const THINKING_PHASE_HALF: AnimatedIcon = {
  frames: PHASE_HALF,
  intervalMs: 140,
}

export const THINKING_PHASE_QUADRANT: AnimatedIcon = {
  frames: PHASE_QUADRANT,
  intervalMs: 140,
}

export const THINKING_BLOCK: AnimatedIcon = {
  frames: BLOCK_ROTOR,
  intervalMs: 120,
}

export const THINKING_ARC_SWEEP: AnimatedIcon = {
  frames: ARC_SWEEP,
  intervalMs: 120,
}

export const THINKING_ARROW_ORBIT: AnimatedIcon = {
  frames: ARROW_ORBIT,
  intervalMs: 110,
}

export const THINKING_CIRCLE_PULSE: AnimatedIcon = {
  frames: CIRCLE_PULSE,
  intervalMs: 150,
  steadyColor: true,
}

export const THINKING_BRAILLE_HEAVY: AnimatedIcon = {
  frames: BRAILLE_ROTOR_HEAVY,
  intervalMs: 100,
}

export const THINKING_BAR_GROW: AnimatedIcon = {
  frames: BAR_GROW,
  intervalMs: 70,
  steadyColor: true,
}

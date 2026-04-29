/**
 * Named, user-selectable spinner presets.
 *
 * Each entry is a factory returning a fully-configured spinner. The CLI
 * flag `--spinner <name>` (and the `MINIMAL_AGENT_SPINNER` env var) look
 * up names from this registry.
 *
 * Add a preset by registering it here — the CLI auto-picks it up via
 * `--list-spinners` and the lookup map.
 *
 * @module spinner/named-presets
 */

import { BlinkingNerdSpinner } from "./blinking-nerd.ts"
import type { Spinner } from "./types.ts"
import type { BlinkingNerdSpinnerTheme } from "./blinking-nerd.ts"
import {
  THINKING_ROTOR_ASCII,
  THINKING_ROTOR_BOX,
  THINKING_DOT_ORBIT,
  THINKING_BREATHING,
  THINKING_PULSE,
  THINKING_PHASE_HALF,
  THINKING_PHASE_QUADRANT,
  THINKING_BLOCK,
} from "./library/frames.ts"
import {
  ANSI_PALETTE_RAINBOW,
  ANSI_PALETTE_COOL,
  ANSI_PALETTE_WARM,
  ANSI_PALETTE_MONO_CYAN,
  ANSI_PALETTE_MONO_DIM,
  ANSI_PALETTE_BREATHE_CYAN,
} from "./library/palettes.ts"

export interface NamedSpinnerPreset {
  /** Identifier passed to `--spinner`. */
  id: string
  /** One-line description shown in `--list-spinners`. */
  description: string
  /** Constructs the spinner instance. */
  factory: () => Spinner<BlinkingNerdSpinnerTheme>
}

/**
 * Registry of named spinner presets. Order is preserved in
 * `--list-spinners` output.
 */
export const SPINNER_PRESETS: readonly NamedSpinnerPreset[] = [
  {
    id: "default",
    description: "ASCII rotor (- \\ | /) at 130ms, rainbow palette.",
    factory: () => new BlinkingNerdSpinner(),
  },
  {
    id: "rotor-box",
    description: "Box-drawing rotor (─ ╲ │ ╱) — no monospace wobble.",
    factory: () =>
      new BlinkingNerdSpinner({
        iconByNotificationId: { "agent.thinking": THINKING_ROTOR_BOX },
        iconByCategory: { agent: THINKING_ROTOR_BOX },
      }),
  },
  {
    id: "dot-orbit",
    description: "Single Braille dot orbiting the cell @ 90ms.",
    factory: () =>
      new BlinkingNerdSpinner({
        iconByNotificationId: { "agent.thinking": THINKING_DOT_ORBIT },
        iconByCategory: { agent: THINKING_DOT_ORBIT },
      }),
  },
  {
    id: "breathing",
    description: "Breathing dot (· ∙ • ● • ∙) @ 160ms, mono-cyan.",
    factory: () =>
      new BlinkingNerdSpinner({
        iconByNotificationId: { "agent.thinking": THINKING_BREATHING },
        iconByCategory: { agent: THINKING_BREATHING },
        colorizers: ANSI_PALETTE_BREATHE_CYAN,
      }),
  },
  {
    id: "pulse",
    description: "Vertical pulse bar (▁▃▄▅▆▇▆▅▄▃) @ 80ms.",
    factory: () =>
      new BlinkingNerdSpinner({
        iconByNotificationId: { "agent.thinking": THINKING_PULSE },
        iconByCategory: { agent: THINKING_PULSE },
        colorizers: ANSI_PALETTE_MONO_CYAN,
      }),
  },
  {
    id: "phase-half",
    description: "Half-circle phase rotation (◐ ◓ ◑ ◒) @ 140ms.",
    factory: () =>
      new BlinkingNerdSpinner({
        iconByNotificationId: { "agent.thinking": THINKING_PHASE_HALF },
        iconByCategory: { agent: THINKING_PHASE_HALF },
        colorizers: ANSI_PALETTE_COOL,
      }),
  },
  {
    id: "phase-quadrant",
    description: "Quadrant rotation (◴ ◷ ◶ ◵) @ 140ms.",
    factory: () =>
      new BlinkingNerdSpinner({
        iconByNotificationId: { "agent.thinking": THINKING_PHASE_QUADRANT },
        iconByCategory: { agent: THINKING_PHASE_QUADRANT },
      }),
  },
  {
    id: "block",
    description: "Heavy block rotor (▖ ▘ ▝ ▗) @ 120ms.",
    factory: () =>
      new BlinkingNerdSpinner({
        iconByNotificationId: { "agent.thinking": THINKING_BLOCK },
        iconByCategory: { agent: THINKING_BLOCK },
        colorizers: ANSI_PALETTE_WARM,
      }),
  },
  {
    id: "ascii-mono",
    description: "ASCII rotor with mono-dim palette — quiet & minimalistic.",
    factory: () =>
      new BlinkingNerdSpinner({
        iconByNotificationId: { "agent.thinking": THINKING_ROTOR_ASCII },
        iconByCategory: { agent: THINKING_ROTOR_ASCII },
        colorizers: ANSI_PALETTE_MONO_DIM,
      }),
  },
  {
    id: "rainbow",
    description: "Default rotor, full rainbow palette.",
    factory: () =>
      new BlinkingNerdSpinner({
        colorizers: ANSI_PALETTE_RAINBOW,
      }),
  },
]

const presetIndex = new Map<string, NamedSpinnerPreset>(SPINNER_PRESETS.map((p) => [p.id, p]))

/** Look up a preset by id. Returns `null` for unknown ids. */
export function getSpinnerPreset(id: string): NamedSpinnerPreset | null {
  return presetIndex.get(id) ?? null
}

/** All registered preset ids in declaration order. */
export function listSpinnerPresetIds(): string[] {
  return SPINNER_PRESETS.map((p) => p.id)
}

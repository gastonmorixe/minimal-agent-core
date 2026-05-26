/**
 * Spinner package — public surface.
 *
 * Layout:
 *
 * - `types.ts`         — `Spinner`, `SpinnerNotification`, `IconSpec`,
 *                        contexts, lifecycle types.
 * - `manager.ts`       — `SpinnerManager` (mounts one spinner at a time,
 *                        owns lifecycle hooks and grace negotiation).
 * - `braille.ts`       — `BrailleSpinner` (frame-cycle, themable accent).
 * - `blinking-nerd.ts` — `BlinkingNerdSpinner` (per-notification icon spec,
 *                        supports both blinking string and animated rotors).
 * - `presets.ts`       — opinionated defaults wired into `BlinkingNerdSpinner`.
 * - `library/`         — catalog of frame sets, icons, palettes.
 *
 * Quick recipes:
 *
 *     // Use the defaults (rotor for thinking, blink for everything else).
 *     new BlinkingNerdSpinner();
 *
 *     // Swap thinking to the box-drawing rotor.
 *     import { THINKING_ROTOR_BOX } from "./spinner/library/frames.ts";
 *     new BlinkingNerdSpinner({
 *       iconByNotificationId: { "agent.thinking": THINKING_ROTOR_BOX },
 *     });
 *
 *     // Custom rotor inline.
 *     new BlinkingNerdSpinner({
 *       iconByNotificationId: {
 *         "agent.thinking": { frames: ["◐", "◓", "◑", "◒"], intervalMs: 140 },
 *       },
 *     });
 *
 * @module spinner
 */

export * from "./blinking-nerd.ts"
export * from "./braille.ts"
export * as library from "./library/index.ts"
export * from "./manager.ts"
export * from "./named-presets.ts"
export * from "./presets.ts"
export * from "./types.ts"

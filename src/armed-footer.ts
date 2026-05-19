/**
 * Armed-state footer renderer.
 *
 * When the abort-quit FSM transitions into the `armed` state (either via
 * Ctrl+C while idle, or via Ctrl+C while working which also aborts), the
 * EditorController paints a single-row footer below the prompt that
 * counts down the 10s confirmation window:
 *
 *     ⊘ press Ctrl+C again within 9s to quit · Esc / type to cancel
 *
 * The renderer is pure — given the FSM's `armed` state and "now", it
 * returns the styled line (or `null` when the window has expired). The
 * host wraps this in a recurring tick.
 *
 * Source-specific copy:
 *   - `idle-confirm` — user hit Ctrl+C with nothing in flight. Heading:
 *     "ready to quit".
 *   - `post-abort`   — user hit Ctrl+C mid-work; the turn was aborted
 *     and the window is open for an immediate follow-up Ctrl+C. Heading:
 *     "aborted — press Ctrl+C again to quit".
 *
 * @module armed-footer
 */

import { c } from "./agent.ts"
import type { ArmedSource } from "./abort-quit-fsm.ts"

export interface ArmedFooterOptions {
  source: ArmedSource
  /** Absolute time the armed window closes (matches FSM state.expiresAt). */
  expiresAt: number
  /** "Now" in the same time base. */
  now: number
}

/**
 * Format the armed-state footer line.
 *
 * @returns the styled line, or `null` if the window has already expired
 *   (the host should hide the footer).
 */
export function formatArmedFooter(opts: ArmedFooterOptions): string | null {
  const remainingMs = opts.expiresAt - opts.now
  if (remainingMs <= 0) return null
  // Always round up so "9.9s remaining" reads "10s" rather than "9s"; the
  // user-visible countdown then steps 10→9→8→…→1 cleanly across the
  // 10s window.
  const seconds = Math.max(1, Math.ceil(remainingMs / 1_000))

  const badge =
    opts.source === "post-abort"
      ? `${c.dimRed("⊘")} ${c.bold("aborted")}`
      : `${c.dim("⌨")} ${c.bold("ready to quit")}`
  const cta = `press ${c.bold("Ctrl+C")} again within ${c.bold(`${seconds}s`)} to quit`
  const cancel = c.dim("· Esc or type to cancel")
  return `  ${badge} ${c.faintWhite("·")} ${c.faintWhite(cta)} ${cancel}`
}

/**
 * Whether the armed footer should still be painted at `now`. Lightweight
 * helper that mirrors {@link formatArmedFooter}'s expiry check; useful in
 * tests and in the EditorController tick path that decides whether to
 * emit `hide-armed`.
 */
export function isArmedFooterActive(expiresAt: number, now: number): boolean {
  return now < expiresAt
}

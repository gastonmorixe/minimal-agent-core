/**
 * Armed-state footer renderer.
 *
 * When the abort-quit FSM transitions into the `armed` state (either via
 * Ctrl+C while idle, or via Ctrl+C while working which also aborts), the
 * EditorController paints a single-row footer below the prompt that
 * counts down the 10s confirmation window:
 *
 *     Quit?  ⌃C confirm · 9s · esc cancel        (idle)
 *     ✘ Aborted.  ⌃C to quit · 9s · esc resume   (post-abort)
 *
 * The renderer is pure — given the FSM's `armed` state and "now", it
 * returns the styled line (or `null` when the window has expired). The
 * host wraps this in a recurring tick.
 *
 * Source-specific copy:
 *   - `idle-confirm` — user hit Ctrl+C with nothing in flight. The
 *     heading is the question `Quit?` (no icon needed: the word does the
 *     work) and the off-ramp is `esc cancel`.
 *   - `post-abort`   — user hit Ctrl+C mid-work; the turn was aborted
 *     and the window is open for an immediate follow-up Ctrl+C. The
 *     heading is `✘ Aborted.` (bold red — same glyph + treatment the
 *     tasks plugin uses for canceled rows, so "this got stopped" has one
 *     visual vocabulary across the agent) and the off-ramp is
 *     `esc resume` (there's nothing to cancel, the work already stopped).
 *
 * Hierarchy: heading (anchor), then ⌃C (action), then Ns (urgency), then esc (off-ramp).
 * `⌃` is U+2303 — the macOS Control symbol the user already sees in every
 * menu item. BMP-narrow, no emoji-presentation risk.
 *
 * @module armed-footer
 */

import type { ArmedSource } from "../../abort-quit-fsm.ts"
import { c } from "../style/ansi.ts"

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

  // Anchor: the heading is the eye's landing point.
  //   - idle:        `Quit?`        — bold, no icon (word carries the meaning).
  //   - post-abort:  `✘ Aborted.`   — bold-red X + bold word (event marker;
  //     `c.dimRed("⊘")` was a thin outline glyph at low contrast, visually
  //     invisible on antialiased fonts).
  const heading =
    opts.source === "post-abort" ? `${c.boldRed("✘")} ${c.bold("Aborted.")}` : c.bold("Quit?")

  // Action: `⌃C` in bold sky + verb in faint white.
  //   - idle:        `⌃C confirm`   (you're agreeing to quit).
  //   - post-abort:  `⌃C to quit`   (the action you'd take next).
  const verb = opts.source === "post-abort" ? "to quit" : "confirm"
  const action = `${c.sky(c.bold("⌃C"))} ${c.faintWhite(verb)}`

  // Urgency: the only thing that changes each tick. Bold gold so the eye
  // can re-anchor on it without re-reading the whole line.
  const time = c.gold(c.bold(`${seconds}s`))

  // Off-ramp: dim, hides at the right edge. Wording differs per source
  // because post-abort has nothing to "cancel" — the work already stopped.
  const offramp = opts.source === "post-abort" ? "esc resume" : "esc cancel"

  const dot = c.faintWhite("·")
  return `  ${heading}  ${action} ${dot} ${time} ${dot} ${c.dim(offramp)}`
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

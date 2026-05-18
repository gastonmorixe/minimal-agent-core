/**
 * Opinionated spinner defaults — the bundles wired into
 * `BlinkingNerdSpinner` out of the box.
 *
 * Swap a single entry without redefining the whole map by passing
 * `iconByNotificationId: { "agent.thinking": <other> }` to the
 * constructor; the spinner shallow-merges your overrides on top of
 * `DEFAULT_ICON_BY_NOTIFICATION_ID`.
 *
 * @module spinner/presets
 */

import type { IconSpec } from "./types.ts"
import { ICON_DOT_FILLED, ICON_DOT_SMALL, ICON_TRIANGLE_RIGHT, NF_LOCK } from "./library/icons.ts"
import { THINKING_ROTOR_ASCII } from "./library/frames.ts"

/** Fallback when no notification matches. Font-free dot, never invisible. */
export const DEFAULT_NERD_ICON: IconSpec = ICON_DOT_SMALL

/**
 * Ships:
 * - `agent.thinking` → ASCII rotor `- \ | /` at 130ms (font-free)
 * - `tool.running`   → blinking `▸` (BMP narrow triangle, "running")
 * - `network.request`→ blinking filled dot
 * - `auth.refresh`   → blinking `nf-md-lock`
 *
 * The `tool.running` icon used to be the Nerd Font `nf-md-tools` PUA
 * glyph (`󱁤` = U+F1064), but PUA codepoints render at 1 OR 2 cells
 * depending on the terminal + font config (UAX-#11 "Ambiguous"), and
 * the agent's column math could not reliably compensate across all
 * combinations — symptom was the icon visually butting against the
 * label ("missing whitespace") on patched-Nerd-Font terminals where
 * the probed value didn't make it to the renderer in time, OR looking
 * loose on unpatched fallback fonts when it did. `▸` is BMP narrow
 * (U+25B8), 1 cell on every terminal, no probe required, no emoji
 * auto-promotion risk. The CPR-probe infra in `src/nerd-glyph-width.ts`
 * is retained for `auth.refresh` (NF_LOCK is still PUA) and any future
 * PUA icon swap-in.
 */
export const DEFAULT_ICON_BY_NOTIFICATION_ID: Readonly<Record<string, IconSpec>> = {
  "agent.thinking": THINKING_ROTOR_ASCII,
  "tool.running": ICON_TRIANGLE_RIGHT,
  "network.request": ICON_DOT_FILLED,
  "auth.refresh": NF_LOCK,
}

export const DEFAULT_ICON_BY_CATEGORY: Readonly<Record<string, IconSpec>> = {
  agent: THINKING_ROTOR_ASCII,
  tool: ICON_TRIANGLE_RIGHT,
  network: ICON_DOT_FILLED,
  auth: NF_LOCK,
}

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

import { THINKING_BREATHING, TOOL_SQUARE_PULSE } from "./library/frames.ts"
import { ICON_DOT_FILLED, ICON_DOT_SMALL, ICON_PAUSE, NF_LOCK } from "./library/icons.ts"
import type { IconSpec } from "./types.ts"

/** Fallback when no notification matches. Font-free dot, never invisible. */
export const DEFAULT_NERD_ICON: IconSpec = ICON_DOT_SMALL

/**
 * Ships:
 * - `agent.thinking`            → breathing dot `· ∙ • ● • ∙` @ 160ms
 *                                  (`steadyColor`: 1 hue per full breath)
 * - `tool.running`              → big/small square size-pulse `◼ ↔ ◾`
 *                                  @ 500ms, rainbow per frame
 * - `network.request`           → blinking filled dot `●` (rainbow per cycle)
 * - `auth.refresh`              → blinking `nf-md-lock` (rainbow per cycle)
 * - `agent.reflection-cooldown` → blinking pause `⏸` (rainbow per cycle)
 *
 * Design notes:
 *
 * - Two animation modes coexist. Animated rotors (`THINKING_BREATHING`,
 *   `TOOL_SQUARE_PULSE`) cycle through frames continuously — the motion
 *   IS the heartbeat. Static glyphs (`ICON_DOT_FILLED`, `NF_LOCK`,
 *   `ICON_PAUSE`) go through `BlinkingNerdSpinner`'s static branch and
 *   blink on/off at 500ms with the rainbow palette rotating per on-cycle.
 *
 * - `agent.thinking` uses `steadyColor: true` (declared on
 *   `THINKING_BREATHING`): color advances once per full breath
 *   (6 × 160ms = 960ms per color), not per frame — calmer cadence to
 *   match the meditative reading of "Thinking…".
 *
 * - `tool.running` omits `steadyColor` on `TOOL_SQUARE_PULSE` so the
 *   color advances per frame: at 500ms intervals `◼` and `◾` each land on
 *   a different palette entry. Cadence intentionally matches the legacy
 *   static-blink rhythm (500ms beats), but the glyph stays continuously
 *   visible — no off-frame whitespace.
 *
 * - `agent.reflection-cooldown` previously fell through to the
 *   `DEFAULT_NERD_ICON` (`·`) because no notification-id OR category
 *   mapping existed. Now mapped to `ICON_PAUSE` (`⏸`).
 *
 * - `auth.refresh` is the only remaining NF-PUA dependency
 *   (`NF_LOCK` = U+F033E). It renders correctly on Nerd Font Mono setups
 *   (PUA collapsed to 1 cell deterministically) and on patched-Nerd-Font
 *   terminals where the CPR probe in `src/nerd-glyph-width.ts` resolves
 *   the actual width. To go fully font-portable, swap to a BMP-narrow
 *   alternative (e.g. `⊙ ⊚ ⊛` from the circled-operators family).
 */
export const DEFAULT_ICON_BY_NOTIFICATION_ID: Readonly<Record<string, IconSpec>> = {
  "agent.thinking": THINKING_BREATHING,
  "tool.running": TOOL_SQUARE_PULSE,
  "network.request": ICON_DOT_FILLED,
  "auth.refresh": NF_LOCK,
  "agent.reflection-cooldown": ICON_PAUSE,
}

export const DEFAULT_ICON_BY_CATEGORY: Readonly<Record<string, IconSpec>> = {
  agent: THINKING_BREATHING,
  tool: TOOL_SQUARE_PULSE,
  network: ICON_DOT_FILLED,
  auth: NF_LOCK,
  reflection: ICON_PAUSE,
}

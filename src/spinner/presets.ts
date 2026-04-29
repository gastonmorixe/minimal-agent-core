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
import { ICON_DOT_FILLED, ICON_DOT_SMALL, NF_LOCK, NF_TOOLS } from "./library/icons.ts"
import { THINKING_ROTOR_ASCII } from "./library/frames.ts"

/** Fallback when no notification matches. Font-free dot, never invisible. */
export const DEFAULT_NERD_ICON: IconSpec = ICON_DOT_SMALL

/**
 * Ships:
 * - `agent.thinking` → ASCII rotor `- \ | /` at 130ms (font-free)
 * - `tool.running`   → blinking `nf-md-tools`
 * - `network.request`→ blinking filled dot
 * - `auth.refresh`   → blinking `nf-md-lock`
 */
export const DEFAULT_ICON_BY_NOTIFICATION_ID: Readonly<Record<string, IconSpec>> = {
  "agent.thinking": THINKING_ROTOR_ASCII,
  "tool.running": NF_TOOLS,
  "network.request": ICON_DOT_FILLED,
  "auth.refresh": NF_LOCK,
}

export const DEFAULT_ICON_BY_CATEGORY: Readonly<Record<string, IconSpec>> = {
  agent: THINKING_ROTOR_ASCII,
  tool: NF_TOOLS,
  network: ICON_DOT_FILLED,
  auth: NF_LOCK,
}

/**
 * ANSI color helpers for the quota-status footer.
 *
 * The host exposes the same wrappers as `c` (`src/ui/style/ansi.ts`), but the
 * decoupling contract (Wave D) forbids importing from `src/`. This module
 * selects the quota footer's subset from the shared plugin-api ANSI helpers so
 * the plugin and host close SGR attributes the same way.
 *
 * @module quota-status/colors
 */

import { ansiStyle } from "@minimal-agent/plugin-api/utils/ansi"

/**
 * The subset of the host's `c` palette the quota footer renders with. Drawn
 * from the shared {@link PALETTE} so the colors match agent-owned chrome.
 */
export const c = {
  dim: ansiStyle.dim,
  bold: ansiStyle.bold,
  green: ansiStyle.green,
  red: ansiStyle.red,
  yellow: ansiStyle.yellow,
  boldGreen: ansiStyle.boldGreen,
  boldRed: ansiStyle.boldRed,
  boldYellow: ansiStyle.boldYellow,
  faintWhite: ansiStyle.faintWhite,
}

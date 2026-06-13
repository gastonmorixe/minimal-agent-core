/**
 * ANSI color helpers for the quota-status footer.
 *
 * The host exposes the same wrappers as `c` (`src/ui/style/ansi.ts`), but the
 * decoupling contract (Wave D) forbids importing from `src/`. The SGR open
 * sequences are provider-neutral and the package owns them (`PALETTE` from
 * `@minimal-agent/plugin-api/utils/palette`), so this module rebuilds the
 * small wrapper subset the renderer uses from that shared palette. Each
 * helper is a pure `(s: string) => string` that opens and closes its own
 * SGR codes, so they compose (`c.bold(c.red("x"))`).
 *
 * @module quota-status/colors
 */

import { PALETTE } from "@minimal-agent/plugin-api/utils/palette"

const fg = (open: string) => (s: string) => `${open}${s}\x1b[39m`
const attr = (open: string, close: string) => (s: string) => `${open}${s}${close}`
const combo = (open: string, close: string) => (s: string) => `${open}${s}${close}`

/**
 * The subset of the host's `c` palette the quota footer renders with. Drawn
 * from the shared {@link PALETTE} so the colors match agent-owned chrome.
 */
export const c = {
  dim: attr("\x1b[2m", "\x1b[22m"),
  bold: attr("\x1b[1m", "\x1b[22m"),
  green: fg(PALETTE.green),
  red: fg(PALETTE.red),
  yellow: fg(PALETTE.yellow),
  boldGreen: combo("\x1b[1;32m", "\x1b[22;39m"),
  boldRed: combo("\x1b[1;31m", "\x1b[22;39m"),
  boldYellow: combo("\x1b[1;33m", "\x1b[22;39m"),
  faintWhite: combo("\x1b[2;37m", "\x1b[22;39m"),
}

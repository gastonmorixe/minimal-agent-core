/**
 * Host-owned logout command chrome.
 *
 * The command layer clears credentials; this module owns the rows users see.
 *
 * @module ui/chrome/logout
 */

import { c } from "../style/ansi.ts"

/** Rows shown before credential removal runs. */
export function renderLogoutStartRows(): string[] {
  return [`  ${c.bold(c.pink("⊖"))} ${c.bold("Sign out")}`]
}

/** Rows shown when credential removal throws but logout continues. */
export function renderLogoutWarningRows(message: string): string[] {
  return [`  ${c.boldYellow("warn")} credential removal failed: ${message}`]
}

/** Rows shown after credential removal finishes. */
export function renderLogoutResultRows(removed: boolean): string[] {
  return [
    `  ${c.faintWhite("╰")} credentials  ${removed ? c.boldGreen("removed") : c.dim("(no entry)")}`,
    ``,
    `  ${c.boldGreen("✔")} ${c.bold("Logged out")}`,
  ]
}

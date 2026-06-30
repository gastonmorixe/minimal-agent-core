/**
 * Host-owned logout command chrome.
 *
 * The command layer clears credentials; this module owns the rows users see.
 *
 * @module ui/chrome/logout
 */

import { c } from "../style/ansi.ts"

/** Rows shown before credential removal runs. */
export function renderLogoutStartRows(providerId?: string): string[] {
  const scope = providerId ? ` ${c.dim(`(${providerId})`)}` : ""
  return [`  ${c.bold(c.pink("⊖"))} ${c.bold("Sign out")}${scope}`]
}

/** Rows shown when credential removal throws but logout continues. */
export function renderLogoutWarningRows(message: string): string[] {
  return [`  ${c.boldYellow("warn")} credential removal failed: ${message}`]
}

/** Rows shown after credential removal finishes. */
export function renderLogoutResultRows(removed: boolean, providerId?: string): string[] {
  const scope = providerId ? ` for ${providerId}` : ""
  return [
    `  ${c.faintWhite("╰")} credentials${scope}  ${removed ? c.boldGreen("removed") : c.dim("(no entry)")}`,
    ``,
    `  ${c.boldGreen("✔")} ${c.bold("Logged out")}`,
  ]
}

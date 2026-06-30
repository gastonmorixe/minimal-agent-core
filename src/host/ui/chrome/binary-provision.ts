/**
 * Startup binary-provisioning chrome.
 *
 * Plugin setup/provisioning logic lives in startup/binaries modules; this file
 * owns the terminal rows shown when mandatory binary setup cannot complete.
 *
 * @module ui/chrome/binary-provision
 */

import { c } from "../style/ansi.ts"

export interface BinaryProvisionHalt {
  pluginId: string
  message: string
}

/** Render the fatal binary-provisioning block shown before boot exits. */
export function renderBinaryProvisionHalt(halt: BinaryProvisionHalt): string[] {
  return [
    "",
    `  ${c.boldRed("✗")} ${c.bold("Setup incomplete")} ${c.dim(`(${halt.pluginId})`)}`,
    ...halt.message.split("\n").map((line) => `  ${c.faintWhite("│")} ${line}`),
    `  ${c.faintWhite("╰")} ${c.dim("fix the above, then re-run. Skip this check with MINIMAL_AGENT_NO_BINARY_SETUP=1.")}`,
  ]
}

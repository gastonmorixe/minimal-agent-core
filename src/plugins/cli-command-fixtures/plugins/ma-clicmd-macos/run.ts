/**
 * Command loader fixture: the handler of a macOS-only plugin.
 *
 * @module plugins/cli-command-fixtures/ma-clicmd-macos/run
 */

import { markImported } from "../../import-log.ts"

markImported("macos/run")

/** Fixture command handler. */
export default async function maccmd(): Promise<number> {
  return 0
}

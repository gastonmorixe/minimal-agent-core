/**
 * Command loader fixture: the handler of a plugin that ships disabled. It
 * loads only when an override force-enables the plugin.
 *
 * @module plugins/cli-command-fixtures/ma-clicmd-off/run
 */

import { markImported } from "../../import-log.ts"

markImported("off/run")

/** Fixture command handler. */
export default async function offcmd(): Promise<number> {
  return 3
}

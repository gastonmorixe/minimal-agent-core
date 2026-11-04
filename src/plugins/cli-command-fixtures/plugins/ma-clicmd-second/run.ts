/**
 * Command loader fixture: the handler of the second plugin. Loads of
 * `ma-clicmd-ok` commands (including the escape paths that point here)
 * must never import it.
 *
 * @module plugins/cli-command-fixtures/ma-clicmd-second/run
 */

import { markImported } from "../../import-log.ts"

markImported("second/run")

/** Fixture command handler. */
export default async function second(): Promise<number> {
  return 0
}

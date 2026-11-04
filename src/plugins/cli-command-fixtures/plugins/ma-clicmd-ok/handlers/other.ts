/**
 * Command loader fixture: the handler of `other`. A test proves the loader
 * does not import it when it loads `sched list`.
 *
 * @module plugins/cli-command-fixtures/ma-clicmd-ok/other
 */

import { markImported } from "../../../import-log.ts"

markImported("ok/other")

/** Fixture command handler. */
export default async function other(): Promise<number> {
  return 0
}

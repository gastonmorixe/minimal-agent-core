/**
 * Command loader fixture: the handler of `sched list`. Importing it
 * records its name in the shared import log.
 *
 * @module plugins/cli-command-fixtures/ma-clicmd-ok/list
 */

import { markImported } from "../../../import-log.ts"

markImported("ok/list")

interface Ctx {
  path: string[]
  stdout: { write(s: string): unknown }
}

/** Fixture command handler. */
export default async function list(ctx: Ctx): Promise<number> {
  ctx.stdout.write(`list ${ctx.path.join(" ")}\n`)
  return 7
}

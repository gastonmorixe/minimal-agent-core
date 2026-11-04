/**
 * Command loader fixture: a handler module with no default export
 * function. The loader must fail with reason `"export"`.
 *
 * @module plugins/cli-command-fixtures/ma-clicmd-ok/noexport
 */

import { markImported } from "../../../import-log.ts"

markImported("ok/noexport")

export const notAHandler = 1

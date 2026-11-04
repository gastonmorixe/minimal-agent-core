/**
 * Command loader fixture: a handler module that throws at import. The
 * loader must fail with reason `"import"`.
 *
 * @module plugins/cli-command-fixtures/ma-clicmd-ok/boom
 */

import { markImported } from "../../../import-log.ts"

markImported("ok/boom")

throw new Error("boom fixture import")

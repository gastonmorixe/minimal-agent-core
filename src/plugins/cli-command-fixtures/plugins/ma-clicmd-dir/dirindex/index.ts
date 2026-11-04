/**
 * Command loader fixture: an implicit `index.ts` of a directory handler
 * path. It re-exports the handler of another plugin, so a load that
 * resolves the directory imports a module outside the package. The loader
 * must reject the directory path before any import (M14A-1).
 *
 * @module plugins/cli-command-fixtures/ma-clicmd-dir/dirindex
 */

export { default } from "../../ma-clicmd-second/run.ts"

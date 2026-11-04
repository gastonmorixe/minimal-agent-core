/**
 * Public re-export shim for `@minimal-agent/core/host/plugin-cli-command`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `loadPluginCliCommand`: load ONE plugin CLI command handler by plugin
 * id and command path (SPEC-HELP R-39, M-14a). It applies the same gates
 * as `buildPluginCliCatalog`, keeps the handler path inside the plugin
 * package, requires it to name a regular file (not a directory), and
 * imports only the selected handler module, by its checked real path.
 * `entryAbsolute` is a machine-local path for local diagnostics only. A
 * host imports
 * this subpath only on the `plugin <cmd>` run route, never from help.
 * See `../plugins/cli-command-loader.ts` for the full contract.
 *
 * @module host-public/plugin-cli-command
 */

export type {
  CliCommandContext,
  CliCommandHandler,
} from "../../plugin-api/src/types/cli-contract.ts"
export {
  type LoadPluginCliCommandInput,
  loadPluginCliCommand,
  type PluginCliCommandLoadFailure,
  type PluginCliCommandLoadResult,
} from "../plugins/cli-command-loader.ts"

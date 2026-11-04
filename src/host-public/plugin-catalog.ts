/**
 * Public re-export shim for `@minimal-agent/core/host/plugin-catalog`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `buildPluginCatalog`: a lightweight filesystem scan (no handler
 * imports) for a `plugins list` style command. `buildPluginCliCatalog`:
 * the help and dispatch catalog (SPEC-HELP R-22, M-5), one
 * `CatalogCliEntry` per plugin with the validated `cli` block and
 * host-mode help, with the loader's platform and `hostMode:stdio` gates.
 * It also imports no handler module. See `../plugins/catalog.ts` for the
 * full contract.
 *
 * Both catalogs apply static gates only. A plugin the loader rejects at
 * load time (a tool name collision, a handler module that fails to
 * resolve) is not visible here and still shows as on. The same is true
 * for a host mode whose entry module fails to resolve.
 *
 * @module host-public/plugin-catalog
 */

export type {
  CatalogCliEntry,
  CatalogCliHostMode,
  CatalogCliHostModeDisabled,
  CatalogCliNote,
  CatalogCliRoot,
} from "../../plugin-api/src/types/cli-contract.ts"
export * from "../plugins/catalog.ts"

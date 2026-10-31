/**
 * Public re-export shim for `@minimal-agent/core/host/plugin-catalog`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `buildPluginCatalog` — a lightweight filesystem scan (no handler
 * imports) for a `plugins list` style command. See
 * `../plugins/catalog.ts` for the full contract.
 *
 * @module host-public/plugin-catalog
 */

export * from "../plugins/catalog.ts"

/**
 * Re-export shim — the implementation moved to the leaf contract package
 * `@minimal-agent/plugin-api` in Wave D-0.
 *
 * Terminal display-width helpers now live at
 * `plugin-api/src/utils/term-width.ts`. This file stays at the old path so
 * every existing core importer (`./term-width.ts`) keeps compiling
 * untouched while plugins migrate to the package import directly. It will
 * be deleted once no core file imports the old path.
 *
 * @module term-width
 */

export * from "@minimal-agent/plugin-api/utils/term-width"

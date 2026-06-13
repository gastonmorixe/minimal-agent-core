/**
 * Re-export shim — the implementation moved to the leaf contract package
 * `@minimal-agent/plugin-api` in Wave D-0.
 *
 * The agent color palette now lives at `plugin-api/src/utils/palette.ts`.
 * This file stays at the old path so every existing core importer
 * (`./palette.ts`) keeps compiling untouched while plugins migrate to the
 * package import directly. `export *` carries both the values
 * (`PALETTE`, `SEMANTIC`, ...) and the `PaletteName` type.
 *
 * @module palette
 */

export * from "@minimal-agent/plugin-api/utils/palette"

/**
 * Re-export shim — the implementation moved to the leaf contract package
 * `@minimal-agent/plugin-api` in Wave D-0.
 *
 * The minimal JSONC parser now lives at `plugin-api/src/utils/jsonc.ts`.
 * This file stays at the old path so every existing core importer
 * (`./jsonc.ts`) keeps compiling untouched while plugins migrate to the
 * package import directly.
 *
 * @module jsonc
 */

export * from "@minimal-agent/plugin-api/utils/jsonc"

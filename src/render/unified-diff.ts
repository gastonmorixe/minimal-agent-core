/**
 * Re-export shim — the implementation moved to the leaf contract package
 * `@minimal-agent/plugin-api` in Wave D-0.
 *
 * The unified-diff colorizer now lives at
 * `plugin-api/src/utils/unified-diff.ts`. This file stays at the old path
 * so every existing core importer (`./render/unified-diff.ts`, re-exported
 * by `src/diff.ts`) keeps compiling untouched. Output is byte-identical
 * (the package file is a verbatim copy, still byte-parity-pinned by
 * `src/render/unified-diff.test.ts`). After the move the diff-view plugin
 * can consume this ONE copy via the package instead of keeping its own.
 *
 * @module render/unified-diff
 */

export * from "@minimal-agent/plugin-api/utils/unified-diff"

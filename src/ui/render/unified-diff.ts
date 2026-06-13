/**
 * Re-export shim — the implementation moved to the leaf contract package
 * `@minimal-agent/plugin-api` in Wave D-0.
 *
 * The unified-diff colorizer now lives at
 * `plugin-api/src/utils/unified-diff.ts`. This file stays at the old path
 * so every core importer can use the UI rendering boundary while host code
 * and plugins consume the same implementation.
 *
 * @module ui/render/unified-diff
 */

export * from "@minimal-agent/plugin-api/utils/unified-diff"

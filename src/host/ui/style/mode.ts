/**
 * Re-export shim — the mode-style resolver moved to the leaf contract
 * package `@minimal-agent/plugin-api`.
 *
 * The implementation now lives at `plugin-api/src/utils/mode-style.ts` so the
 * host TUI, plugin chrome, and core `modes.ts` all resolve mode styling from
 * one pure, dependency-free module. This file stays at the old host path for
 * back-compat with existing importers (`mode.test.ts`, etc.).
 *
 * @module ui/style/mode
 */

export * from "@minimal-agent/plugin-api/utils/mode-style"

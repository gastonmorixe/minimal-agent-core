/**
 * Re-export shim — the mode-style resolver used to live in the leaf
 * contract package `@minimal-agent/core/plugin-api`. That contract moved
 * to `minimal-agent-cli/src/terminal-kit` (spec S33). This host code
 * still lives in core pending S34, so it re-exports the temporary
 * internal bridge copy (`src/internal/terminal-render`) instead. This
 * file stays at the old host path for back-compat with existing
 * importers (`mode.test.ts`, etc.).
 *
 * @module ui/style/mode
 */

export * from "../../../internal/terminal-render/mode-style.ts"

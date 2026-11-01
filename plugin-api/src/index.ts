/**
 * `@minimal-agent/core/plugin-api` — the leaf contract package.
 *
 * Provider-neutral types and pure utilities shared by the host (`src/`)
 * and the plugins tree. This package imports NOTHING from `src/` or
 * `plugins/` (enforced by `src/architecture.plugin-api-leaf.test.ts`):
 * it is a true leaf so a plugin can depend on it from its own repo after
 * the Wave-G split.
 *
 * The root export re-surfaces the pure-utils namespace. Subpath exports
 * (`@minimal-agent/core/plugin-api/utils/<name>`) are the preferred import
 * shape — they let a consumer pull one utility without dragging the rest.
 *
 * Wave D-0 contents: pure, host-state-free utilities only —
 * `term-width`, `jsonc`, `palette`, `ansi`, `sse-parser`, `unified-diff`. Types
 * land in D-1.
 *
 * `usage-render`, `footer-tail`, `decoration-suffix`, and `mode-style` — four
 * of the eight terminal-rendering helpers — moved to
 * `minimal-agent-cli/src/terminal-kit` (spec S33). `usage-report` stays here:
 * it is pure folded-report data, not rendering code. `term-width`, `palette`,
 * and `ansi` stay too, for now: real sibling plugins (`ma-schedule-plugin`,
 * `ma-memory-plugin`, `ma-quota-status-plugin`, `ma-diagnostics-plugin`)
 * import them directly for tool-handler output, not just optional TUI
 * cosmetics, and core's loader drops a plugin's ENTIRE tool set (not just the
 * one import) when a single handler fails to resolve — moving them now would
 * break real plugin functionality, not just rendering. See the S33 session
 * report; this is flagged, not silently deferred.
 *
 * @module plugin-api
 */

export * from "./utils/term-width.ts"
export * from "./utils/jsonc.ts"
export * from "./utils/palette.ts"
export * from "./utils/ansi.ts"
export * from "./utils/usage-report.ts"
export * from "./utils/sse-parser.ts"
export * from "./utils/unified-diff.ts"
export * from "./utils/style-slots.ts"
export * from "./utils/platform.ts"

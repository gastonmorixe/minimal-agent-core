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
 * `term-width`, `jsonc`, `sse-parser`, `style-slots`. Types land in D-1.
 *
 * The terminal-rendering helpers moved to `minimal-agent-cli/src/terminal-kit`:
 * `usage-render`, `footer-tail`, `decoration-suffix`, and `mode-style` (spec
 * S33), then `ansi`, `palette`, and `unified-diff` (S41). Plugin `ui` code
 * gets them through `ctx.tui.kit`. Headless plugin code reads plain style
 * slots (`style-slots`). `usage-report` stays: it is folded-report data, not
 * rendering code. `term-width` stays: it measures and strips, it does not
 * paint (decision 18).
 *
 * @module plugin-api
 */

export * from "./utils/term-width.ts"
export * from "./utils/jsonc.ts"
export * from "./utils/usage-report.ts"
export * from "./utils/sse-parser.ts"
export * from "./utils/style-slots.ts"
export * from "./utils/platform.ts"
export type * from "./types/startup-rows.ts"
export * from "./types/tool-outcome.ts"

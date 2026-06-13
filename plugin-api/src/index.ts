/**
 * `@minimal-agent/plugin-api` — the leaf contract package.
 *
 * Provider-neutral types and pure utilities shared by the host (`src/`)
 * and the plugins tree. This package imports NOTHING from `src/` or
 * `plugins/` (enforced by `src/architecture.plugin-api-leaf.test.ts`):
 * it is a true leaf so a plugin can depend on it from its own repo after
 * the Wave-G split.
 *
 * The root export re-surfaces the pure-utils namespace. Subpath exports
 * (`@minimal-agent/plugin-api/utils/<name>`) are the preferred import
 * shape — they let a consumer pull one utility without dragging the rest.
 *
 * Wave D-0 contents: pure, host-state-free utilities only —
 * `term-width`, `jsonc`, `palette`, `sse-parser`, `unified-diff`. Types
 * land in D-1.
 *
 * @module plugin-api
 */

export * from "./utils/term-width.ts"
export * from "./utils/jsonc.ts"
export * from "./utils/palette.ts"
export * from "./utils/sse-parser.ts"
export * from "./utils/unified-diff.ts"

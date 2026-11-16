/**
 * Hook context entry: the item type of `additionalContext` in a hook result.
 *
 * Data only. This is the one source of truth. Core
 * (`src/sdk/hook-context.ts`) imports this type, and plugin authors import
 * it from `@minimal-agent/core/plugin-api/types/plugin`.
 *
 * @module plugin-api/types/hook-context
 */

/**
 * One hook context entry. A string means `"after"`. An object without a
 * `position` also means `"after"`. `"before"` puts the text before the user
 * prompt in the first user message of a turn. The position counts only on
 * `turn.willStart` and `session.willStart`. Other channels use the text.
 */
export type HookContextEntry = string | { text: string; position?: "before" | "after" }

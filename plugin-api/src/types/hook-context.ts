/**
 * Hook context entry: the item type of `additionalContext` in a hook result.
 *
 * Data only. This is the one source of truth. Core
 * (`src/sdk/hook-context.ts`) imports this type, and plugin authors import
 * it from `@minimal-agent/core/plugin-api/types/plugin`.
 *
 * @module plugin-api/types/hook-context
 */

import type { PromptTemplateText } from "./plugin.ts"

/**
 * One hook context entry. A string means `"after"`. An object without a
 * `position` also means `"after"`. `"before"` puts the text before the user
 * prompt in the first user message of a turn. The position counts only on
 * `turn.willStart` and `session.willStart`. Other channels use the text.
 *
 * `origin` is debug metadata only: a short label of the hook that wrote the
 * text, for example `hooks · turn.willStart · user · ~/.minimal-agent/hooks.json`.
 * Core copies it onto the block mark (`sideband.origin`), and no encoder
 * sends it to a provider. The injected text does not change, so the label
 * costs no model tokens.
 *
 * A `text` string is data: core sends it unchanged. An object entry with
 * `template: true` is a prompt template (the hook form of a
 * {@link PromptTemplateText}): core renders `text` with `vars` (and
 * `agentHome`) where it uses the entry. The template text stays in `text`,
 * so code that reads `entry.text` keeps its type.
 */
export type HookContextEntry =
  | string
  | {
      text: string
      position?: "before" | "after"
      origin?: string
      /** True: `text` is a prompt template that core renders. */
      template?: true
      /** Variable values of the template. Read only with `template: true`. */
      vars?: PromptTemplateText["vars"]
    }

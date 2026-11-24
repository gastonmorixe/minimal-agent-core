/**
 * The one point where core renders a prompt text (step 14, design 50 §2).
 *
 * Core holds no template syntax and no tag format. The engine is the
 * `prompts.template` provider (`PromptTemplateProvider.expand` with a ctx).
 * Core calls {@link PromptExpander} at each point of use of a prompt text:
 *
 * - Static text (a contract: `PROMPT.md`, tool text, system prompt parts and
 *   identity): core always renders it. Pass the string.
 * - Text from plugin CODE: a plain string is data and passes unchanged
 *   ({@link expandPluginText}). Only a {@link PromptTemplateText} is rendered.
 *
 * With no provider, the old core rule applies: only `agentHome` is filled
 * ({@link renderInstructions}). When the engine throws, the raw text goes
 * out (fail open) and one `prompt.template_failed` diagnostic is sent for
 * each source.
 *
 * @module plugins/prompt-expand
 */

import { resolveAgentHome } from "../agent/agent-paths.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import { renderInstructions } from "../llm/instructions-block.ts"
import { NO_SIDEBAND, sidebandForPlugin } from "../sideband/api.ts"
import type { SidebandApi } from "../sideband/types.ts"

import type { PromptTemplateProvider, PromptTemplateText, PromptTemplateVars } from "./types.ts"

/** Options of one {@link PromptExpander} call. */
export interface PromptExpandOptions {
  /** Where the text comes from (for example `plugin:<id>:PROMPT.md`). Keys the diagnostic. */
  source?: string
  /** More vars (for example the facts of a synthetic kind). They win over the standard vars; the template vars win over them. */
  vars?: PromptTemplateVars
}

/**
 * Render a prompt text. A string is static prompt text (a contract). A
 * {@link PromptTemplateText} is a template from plugin code (strict vars).
 * Never throws.
 */
export type PromptExpander = (
  text: string | PromptTemplateText,
  opts?: PromptExpandOptions,
) => string

/** Inputs of {@link createPromptExpander}. */
export interface PromptExpanderDeps {
  /** The `prompts.template` provider, read at each call. */
  templateProvider: () => PromptTemplateProvider | undefined
  /** The sideband API of the load, read at each call. Default: `NO_SIDEBAND`. */
  sideband?: () => SidebandApi
  /** Target of `prompt.template_failed`. Without it, no diagnostic is sent. */
  diagnostics?: Pick<Diagnostics, "warn">
  /** The `agentHome` var. Default: {@link resolveAgentHome}, read at each call. */
  agentHome?: () => string
}

/** True when `v` is a {@link PromptTemplateText}. */
export function isPromptTemplateText(v: unknown): v is PromptTemplateText {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false
  return typeof (v as { template?: unknown }).template === "string"
}

/**
 * Build the one expander of a load. See the module doc for the rules.
 *
 * @param deps - The provider, the sideband API, the diagnostics target.
 * @returns The expander.
 */
export function createPromptExpander(deps: PromptExpanderDeps): PromptExpander {
  const failed = new Set<string>()
  // The provider is plugin code: no display read scope (`sidebandForPlugin`).
  const sideband = () => sidebandForPlugin(deps.sideband?.() ?? NO_SIDEBAND, undefined)
  const agentHome = deps.agentHome ?? resolveAgentHome
  return (input, opts = {}) => {
    const strict = typeof input !== "string"
    const text = typeof input === "string" ? input : input.template
    const home = agentHome()
    // Order of precedence: the template vars, then the call vars, then the standard vars.
    const vars: PromptTemplateVars = {
      agentHome: home,
      ...opts.vars,
      ...(strict ? input.vars : undefined),
    }
    const provider = deps.templateProvider()
    if (provider === undefined) {
      const value = vars.agentHome
      return renderInstructions(text, typeof value === "string" ? value : home)
    }
    try {
      return provider.expand(text, {
        vars,
        sideband: sideband(),
        ...(opts.source !== undefined ? { source: opts.source } : {}),
        ...(strict ? { strict: true } : {}),
      })
    } catch (e) {
      const key = opts.source ?? ""
      if (!failed.has(key)) {
        failed.add(key)
        deps.diagnostics?.warn("prompt.template_failed", "", {
          source: key,
          error: e instanceof Error ? e.name : typeof e,
        })
      }
      return text
    }
  }
}

/**
 * Text from plugin CODE (a fragment result, a synthetic text): a string is
 * data and passes unchanged. A {@link PromptTemplateText} is rendered with
 * `expand`. Any other value gives `undefined`.
 */
export function expandPluginText(
  value: unknown,
  expand: PromptExpander,
  opts?: PromptExpandOptions,
): string | undefined {
  if (typeof value === "string") return value
  if (isPromptTemplateText(value)) return expand(value, opts)
  return undefined
}

/** An expander with no provider: the old core rule (`agentHome` only). For tests and bare hosts. */
export const DEFAULT_PROMPT_EXPANDER: PromptExpander = createPromptExpander({
  templateProvider: () => undefined,
})

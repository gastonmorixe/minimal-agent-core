/**
 * Provider-NEUTRAL system-prompt instructions block.
 *
 * The big cached `system[2]` block (base instructions + the
 * tool-output-conventions paragraph) is the same for EVERY
 * provider: it carries no provider wire shape, no billing header, no
 * provider-specific identity. Those provider-specific preambles are resolved
 * separately (see `src/llm/system-prompt.ts` + each provider's
 * `resolveSystemPrompt`).
 *
 * This module owns the neutral assembly. It was extracted out of the legacy
 * Anthropic-flavored `src/headers.ts` (refactor "Wave 4" dissolution) so the
 * neutral builders no longer live in a provider-shaped file. `headers.ts`
 * re-exports these names for back-compat with existing importers; the
 * provider-neutral builder (`src/llm/system-prompt.ts`) imports them from
 * here directly.
 *
 * @module llm/instructions-block
 */

import { resolveAgentHome } from "../agent/agent-paths.ts"
import {
  collectSystemPromptParts,
  type SystemPromptBaseHolder,
  slotOwnedByCtxProvider,
} from "../plugins/system-prompt-base.ts"
import type { SystemPromptPartsContext, SystemPromptSlot } from "../plugins/types.ts"

import { getSystemPromptBase } from "./system-prompt-base-registry.ts"
import {
  applyPromptPartOverride,
  isActivePromptOverride,
  type SystemPromptOverrides,
} from "./system-prompt-overrides.ts"

/**
 * Options shared by the instructions-block text builder. Pulled out so the
 * provider-neutral system-prompt builder (`src/llm/system-prompt.ts`) and the
 * legacy `buildSystemPrompt` produce a byte-identical instructions block.
 */
export interface InstructionsBlockOptions {
  instructions?: string
  blobStoreEnabled?: boolean
  /** Resolved system-prompt overrides for instructions/toolOutputConventions. */
  overrides?: SystemPromptOverrides
  /** The base prompt providers of the calling host. Falls back to the global registry. */
  systemPromptBase?: SystemPromptBaseHolder
  /**
   * Value of `%%agentHome%%` in the instructions template. Default: the
   * resolved agent home (`MINIMAL_AGENT_HOME`, else `~/.minimal-agent`).
   */
  agentHome?: string
}

/**
 * The parts of the registered base holder for all slots, read now with the
 * facts `ctx`. A slot with no provider is not in the map.
 */
function registryParts(
  ctx: SystemPromptPartsContext,
  opts?: InstructionsBlockOptions,
): { parts: Map<SystemPromptSlot, string>; ctxInstructions: boolean } {
  const holder = opts?.systemPromptBase ?? getSystemPromptBase()
  if (holder === undefined) return { parts: new Map(), ctxInstructions: false }
  return {
    parts: collectSystemPromptParts(holder, ctx),
    ctxInstructions: slotOwnedByCtxProvider(holder, "instructions"),
  }
}

/**
 * The instructions text before the override. `opts.instructions` gets
 * `%%agentHome%%` rendered (old behavior). With no provider part the slot is
 * off (`undefined`): core holds no default text. So does the part of an
 * old-style provider (no `slots`), which ships the template. The part of a
 * provider with `slots` is used as is: it renders agentHome from the ctx.
 */
function instructionsText(
  opts: InstructionsBlockOptions | undefined,
  registry: { parts: Map<SystemPromptSlot, string>; ctxInstructions: boolean },
  agentHome: string,
): string | undefined {
  if (opts?.instructions !== undefined) return renderInstructions(opts.instructions, agentHome)
  const part = registry.parts.get("instructions")
  if (part === undefined) return undefined
  return registry.ctxInstructions ? part : renderInstructions(part, agentHome)
}

/**
 * Assemble the text of the cached instructions block (the big system[2]
 * block): the base instructions, then the tool-output-conventions
 * paragraph. Empty fragments are dropped so the
 * "everything-off" case is byte-stable (the cache key depends on it).
 *
 * This is the provider-NEUTRAL portion of the system prompt. The leading
 * identity/billing blocks differ per provider and are resolved separately
 * (see `src/llm/system-prompt.ts` + each provider's `resolveSystemPrompt`).
 */
export function buildInstructionsBlockText(opts?: InstructionsBlockOptions): string {
  return buildInstructionsBlockParts(opts)
    .map((p) => p.text)
    .join("\n\n")
}

/** One non-empty fragment of the instructions block. */
export interface InstructionsBlockPart {
  /** The slot that owns the fragment. */
  readonly slot: "instructions" | "toolOutputConventions"
  /** The fragment text. Never empty. */
  readonly text: string
  /** True when an override entry for the slot replaced the default. */
  readonly overridden: boolean
}

/**
 * The non-empty fragments of the instructions block, in order. The block
 * text is these texts joined with a blank line
 * ({@link buildInstructionsBlockText}).
 */
export function buildInstructionsBlockParts(
  opts?: InstructionsBlockOptions,
): InstructionsBlockPart[] {
  const blobStoreEnabled = opts?.blobStoreEnabled ?? false
  const agentHome = opts?.agentHome ?? resolveAgentHome()
  const overrides = opts?.overrides
  // A slot with a provider part wins (an empty part means the slot is off).
  // A slot with no provider is off. An override still applies per slot, so a
  // `replace` on a slot with no provider gives the override text.
  const registry = registryParts({ blobStoreEnabled, agentHome }, opts)
  const parts = registry.parts
  const candidates: Array<[InstructionsBlockPart["slot"], string | undefined]> = [
    [
      "instructions",
      applyPromptPartOverride(instructionsText(opts, registry, agentHome), overrides?.instructions),
    ],
    [
      "toolOutputConventions",
      applyPromptPartOverride(parts.get("toolOutputConventions"), overrides?.toolOutputConventions),
    ],
  ]
  const out: InstructionsBlockPart[] = []
  for (const [slot, text] of candidates) {
    if (text === undefined || text.length === 0) continue
    out.push({ slot, text, overridden: isActivePromptOverride(overrides?.[slot]) })
  }
  return out
}

/**
 * Fill `%%agentHome%%` in an instructions template: the resolved agent home
 * (`MINIMAL_AGENT_HOME`, else `~/.minimal-agent`). Used for caller text
 * (`opts.instructions`) and for the part of an old-style provider (no
 * `slots`). Text with no placeholder comes back unchanged. Core holds no
 * template text and no template engine: this is the one substitution.
 *
 * @param template - Instructions text from the caller or a base prompt plugin.
 * @param agentHome - Agent home path. Default: {@link resolveAgentHome}.
 * @returns The rendered text.
 */
export function renderInstructions(template: string, agentHome = resolveAgentHome()): string {
  return template.replaceAll("%%agentHome%%", agentHome)
}

/**
 * Provider-NEUTRAL system-prompt instructions block.
 *
 * The big cached `system[2]` block (base instructions + the loop-safety
 * paragraph + the tool-output-conventions paragraph) is the same for EVERY
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
import { DEFAULT_REFLECTION_COOLDOWN_MS, DEFAULT_REFLECTION_INTERVAL } from "../agent/reflection.ts"
import {
  collectSystemPromptParts,
  type SystemPromptBaseHolder,
  slotOwnedByCtxProvider,
} from "../plugins/system-prompt-base.ts"
import type { SystemPromptPartsContext, SystemPromptSlot } from "../plugins/types.ts"
import { loadPromptText, promptPath, renderPrompt, renderTemplate } from "../prompts/prompts.ts"

import { getSystemPromptBase } from "./system-prompt-base-registry.ts"
import {
  applyPromptPartOverride,
  isActivePromptOverride,
  type SystemPromptOverrides,
} from "./system-prompt-overrides.ts"

/**
 * Resolve a core prompt file under `src/prompts/`. Prose for the system
 * prompt lives in markdown; see `src/prompts/README.md`. This module sits in
 * `src/llm/`, so the path climbs one level (`..`) to reach `src/prompts/`.
 *
 * @param segments - Path segments under `src/prompts/`.
 * @returns Absolute path to the prompt file.
 */
function corePrompt(...segments: string[]): string {
  return promptPath(import.meta, "..", "prompts", ...segments)
}

/**
 * Build the harness-safety paragraph appended to `system[2]` so the model
 * knows about the reflection checkpoint, the cooldown, and the ack/silence
 * opt-out.
 *
 * Text is stable as a function of inputs, so the prompt cache key only
 * changes when the configuration changes : default-config sessions all
 * share the same cached prefix.
 *
 * There is no round cap, so the paragraph never mentions one.
 */
export function buildLoopSafetyParagraph(opts: {
  reflectionInterval: number
  reflectionCooldownMs: number
}): string {
  const { reflectionInterval, reflectionCooldownMs } = opts
  const hasReflection = reflectionInterval > 0
  const hasCooldown = hasReflection && reflectionCooldownMs > 0
  if (!hasReflection) return ""

  const cooldownSec = Math.round(reflectionCooldownMs / 1000)
  // Prose lives in `prompts/loop-safety/*`; the conditional assembly (which
  // fragment, in what order) stays here. The structure mirrors the original
  // string-literal build 1:1 so the rendered output is byte-identical.
  const lp = (file: string): string => corePrompt("loop-safety", file)
  const parts: string[] = [renderPrompt(lp("heading.md")), ""]

  parts.push(renderPrompt(lp("intro.md")), "")
  parts.push(
    hasCooldown
      ? renderPrompt(lp("checkpoint-cooldown.tmpl.md"), {
          interval: reflectionInterval,
          cooldownSec,
        })
      : renderPrompt(lp("checkpoint-plain.tmpl.md"), { interval: reflectionInterval }),
  )
  parts.push("", renderPrompt(lp("ack.md")))

  return parts.join("\n")
}

/**
 * Build the "Tool output conventions" paragraph appended to `system[2]`
 * so the model knows about the per-session raw-output blob store and
 * the `<ma::agent::raw-output …/>` pointer footer convention. One short section,
 * tool-agnostic: every tool that returns a large or clamped body lands
 * a full copy at `<sid>.blobs/<tool_use_id>.raw` and the path is
 * appended to the model-visible `tool_result.content`. The model uses
 * `Read` (or `Bash`) on that path when the inline body isn't enough.
 *
 * Returns an empty string when the blob store is disabled, so the
 * cache key is identical to a session without the feature.
 *
 * Pure function of `opts.blobStoreEnabled` (and a stable copy text):
 * default-config sessions all share the same cached prefix.
 */
export function buildToolOutputConventionsParagraph(opts: { blobStoreEnabled: boolean }): string {
  if (!opts.blobStoreEnabled) return ""
  return renderPrompt(corePrompt("tool-output-conventions.md"))
}

/**
 * Options shared by the instructions-block text builder. Pulled out so the
 * provider-neutral system-prompt builder (`src/llm/system-prompt.ts`) and the
 * legacy `buildSystemPrompt` produce a byte-identical instructions block.
 */
export interface InstructionsBlockOptions {
  instructions?: string
  reflectionInterval?: number
  reflectionCooldownMs?: number
  blobStoreEnabled?: boolean
  /** Resolved system-prompt overrides for instructions/loopSafety/toolOutputConventions. */
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
 * The instructions text before the override. `opts.instructions` and the core
 * default get `%%agentHome%%` rendered (old behavior). So does the part of an
 * old-style provider (no `slots`), which ships the template. The part of a
 * provider with `slots` is used as is: it renders agentHome from the ctx.
 */
function instructionsText(
  opts: InstructionsBlockOptions | undefined,
  registry: { parts: Map<SystemPromptSlot, string>; ctxInstructions: boolean },
  agentHome: string,
): string {
  if (opts?.instructions !== undefined) return renderInstructions(opts.instructions, agentHome)
  const part = registry.parts.get("instructions")
  if (part === undefined) return renderInstructions(DEFAULT_INSTRUCTIONS, agentHome)
  return registry.ctxInstructions ? part : renderInstructions(part, agentHome)
}

/**
 * Assemble the text of the cached instructions block (the big system[2]
 * block): the base instructions, then the loop-safety paragraph, then the
 * tool-output-conventions paragraph. Empty fragments are dropped so the
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
  readonly slot: "instructions" | "loopSafety" | "toolOutputConventions"
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
  const reflectionInterval = opts?.reflectionInterval ?? DEFAULT_REFLECTION_INTERVAL
  const reflectionCooldownMs = opts?.reflectionCooldownMs ?? DEFAULT_REFLECTION_COOLDOWN_MS
  const blobStoreEnabled = opts?.blobStoreEnabled ?? false
  const agentHome = opts?.agentHome ?? resolveAgentHome()
  const overrides = opts?.overrides
  // A slot with a provider part wins (an empty part means the slot is off).
  // A slot with no provider falls back to the core builder.
  const registry = registryParts(
    { reflectionInterval, reflectionCooldownMs, blobStoreEnabled, agentHome },
    opts,
  )
  const parts = registry.parts
  const candidates: Array<[InstructionsBlockPart["slot"], string | undefined]> = [
    [
      "instructions",
      applyPromptPartOverride(instructionsText(opts, registry, agentHome), overrides?.instructions),
    ],
    [
      "loopSafety",
      applyPromptPartOverride(
        parts.get("loopSafety") ??
          buildLoopSafetyParagraph({ reflectionInterval, reflectionCooldownMs }),
        overrides?.loopSafety,
      ),
    ],
    [
      "toolOutputConventions",
      applyPromptPartOverride(
        parts.get("toolOutputConventions") ??
          buildToolOutputConventionsParagraph({ blobStoreEnabled }),
        overrides?.toolOutputConventions,
      ),
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
 * Minimal instructions template for system[2], read from
 * `src/prompts/instructions.md`. The real CLI sends ~11K chars of detailed
 * behavioral instructions; this is a minimal version for research use.
 * Override via `buildInstructionsBlockText({ instructions: … })`.
 *
 * This is the TEMPLATE text: it holds `%%agentHome%%`. Use
 * {@link renderInstructions} to fill it.
 */
export const DEFAULT_INSTRUCTIONS = loadPromptText(corePrompt("instructions.md")).trim()

/**
 * Fill the placeholders of an instructions template. The only variable is
 * `agentHome`: the resolved agent home (`MINIMAL_AGENT_HOME`, else
 * `~/.minimal-agent`). Text with no placeholder comes back unchanged.
 *
 * @param template - Instructions text, from core or from a base prompt plugin.
 * @param agentHome - Agent home path. Default: {@link resolveAgentHome}.
 * @returns The rendered text.
 */
export function renderInstructions(template: string, agentHome = resolveAgentHome()): string {
  return renderTemplate(template, { agentHome }, { trim: false })
}

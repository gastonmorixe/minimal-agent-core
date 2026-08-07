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

import { DEFAULT_REFLECTION_COOLDOWN_MS, DEFAULT_REFLECTION_INTERVAL } from "../agent/reflection.ts"
import { promptPath, renderPrompt } from "../prompts/prompts.ts"

import { applyPromptPartOverride, type SystemPromptOverrides } from "./system-prompt-overrides.ts"

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
 * knows about the reflection checkpoint, the cooldown, the ack/silence
 * opt-out, and (when configured) the emergency hard cap.
 *
 * Text is stable as a function of inputs, so the prompt cache key only
 * changes when the configuration changes : default-config sessions all
 * share the same cached prefix.
 *
 * The emergency-cap paragraph is OMITTED when `maxToolRounds` is
 * non-finite (the default, `Infinity`), so a default-configured session
 * sees no mention of a hard cap : there isn't one.
 */
export function buildLoopSafetyParagraph(opts: {
  reflectionInterval: number
  reflectionCooldownMs: number
  maxToolRounds: number
}): string {
  const { reflectionInterval, reflectionCooldownMs, maxToolRounds } = opts
  const hasReflection = reflectionInterval > 0
  const hasCooldown = hasReflection && reflectionCooldownMs > 0
  const hasEmergencyCap = Number.isFinite(maxToolRounds)
  if (!hasReflection && !hasEmergencyCap) return ""

  const cooldownSec = Math.round(reflectionCooldownMs / 1000)
  // Prose lives in `prompts/loop-safety/*`; the conditional assembly (which
  // fragment, in what order) stays here. The structure mirrors the original
  // string-literal build 1:1 so the rendered output is byte-identical.
  const lp = (file: string): string => corePrompt("loop-safety", file)
  const parts: string[] = [renderPrompt(lp("heading.md")), ""]

  if (hasReflection) {
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
  }

  if (hasEmergencyCap) {
    parts.push("", renderPrompt(lp("emergency-cap.tmpl.md"), { maxToolRounds }))
  }

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
  maxToolRounds?: number
  blobStoreEnabled?: boolean
  /** Resolved system-prompt overrides for instructions/loopSafety/toolOutputConventions. */
  overrides?: SystemPromptOverrides
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
  const reflectionInterval = opts?.reflectionInterval ?? DEFAULT_REFLECTION_INTERVAL
  const reflectionCooldownMs = opts?.reflectionCooldownMs ?? DEFAULT_REFLECTION_COOLDOWN_MS
  const maxToolRounds = opts?.maxToolRounds ?? Number.POSITIVE_INFINITY
  const blobStoreEnabled = opts?.blobStoreEnabled ?? false
  const overrides = opts?.overrides
  const instructionsBase = applyPromptPartOverride(
    opts?.instructions ?? DEFAULT_INSTRUCTIONS,
    overrides?.instructions,
  )
  const safetyParagraph = applyPromptPartOverride(
    buildLoopSafetyParagraph({
      reflectionInterval,
      reflectionCooldownMs,
      maxToolRounds,
    }),
    overrides?.loopSafety,
  )
  const conventionsParagraph = applyPromptPartOverride(
    buildToolOutputConventionsParagraph({ blobStoreEnabled }),
    overrides?.toolOutputConventions,
  )
  return [instructionsBase, safetyParagraph, conventionsParagraph]
    .filter((s): s is string => s !== undefined && s.length > 0)
    .join("\n\n")
}

/**
 * Minimal instructions block for system[2], rendered from
 * `src/prompts/instructions.md`. The real CLI sends ~11K chars of detailed
 * behavioral instructions; this is a minimal version for research use.
 * Override via `buildInstructionsBlockText({ instructions: … })`.
 */
export const DEFAULT_INSTRUCTIONS = renderPrompt(corePrompt("instructions.md"))

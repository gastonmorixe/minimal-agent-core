/**
 * Mode texts through the G3 synthetic text resolver (core-prompts decouple
 * P1.5). Each helper asks for one `mode.*` kind with data-only facts and
 * passes the old PROMPTS.ts text as the fallback, so the bytes stay equal
 * when no provider owns the kind.
 *
 * @module modes/mode-text
 */

import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"

import { activeModeStamp, modeChangeAttachment, modeToolRefusalMessage } from "./PROMPTS.ts"

/** `mode.refusal`: facts `tool`, `modeId`, `label`, `hint?` (absent when empty). */
export function modeRefusalText(
  text: SyntheticTextResolver,
  args: { toolName: string; modeId: string; label: string; refusalHint?: string },
): string {
  const facts: Record<string, string> = {
    tool: args.toolName,
    modeId: args.modeId,
    label: args.label,
  }
  if (args.refusalHint) facts.hint = args.refusalHint
  return text.resolve("mode.refusal", facts, () =>
    modeToolRefusalMessage({
      toolName: args.toolName,
      label: args.label,
      refusalHint: args.refusalHint,
    }),
  )
}

/** `mode.active_stamp`: facts `id`, `since` (ISO time). */
export function modeActiveStampText(
  text: SyntheticTextResolver,
  id: string,
  since: string,
): string {
  return text.resolve("mode.active_stamp", { id, since }, () => activeModeStamp(id, since))
}

/** `mode.change`: facts `from`, `to`, `at` (ISO time). `default` is no mode. */
export function modeChangeText(
  text: SyntheticTextResolver,
  args: { from: string; to: string; at: string },
): string {
  return text.resolve("mode.change", { from: args.from, to: args.to, at: args.at }, () =>
    modeChangeAttachment(args),
  )
}

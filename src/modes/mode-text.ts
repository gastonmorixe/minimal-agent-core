/**
 * Mode texts through the G3 synthetic text resolver (core-prompts decouple
 * P1.5). Each helper asks for one `mode.*` kind with data-only facts. With
 * no provider the result is "" (bare core).
 *
 * @module modes/mode-text
 */

import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"

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
  return text.resolve("mode.refusal", facts)
}

/** `mode.active_stamp`: facts `id`, `since` (ISO time). */
export function modeActiveStampText(
  text: SyntheticTextResolver,
  id: string,
  since: string,
): string {
  return text.resolve("mode.active_stamp", { id, since })
}

/** `mode.change`: facts `from`, `to`, `at` (ISO time). `default` is no mode. */
export function modeChangeText(
  text: SyntheticTextResolver,
  args: { from: string; to: string; at: string },
): string {
  return text.resolve("mode.change", { from: args.from, to: args.to, at: args.at })
}

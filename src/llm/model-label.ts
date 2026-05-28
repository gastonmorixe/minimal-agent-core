/**
 * Compact provider-tagged model labels for dense UI (the footer,
 * `--list-models`).
 *
 * Maps a model id to e.g. `anth-4.8` / `oai-5.5` / `oai-4o`: the
 * provider's `shortCode` (from the ProviderPlugin registry) joined to a
 * version token parsed from the id. Falls back to a prefix heuristic
 * when the model isn't registered, so forward-compat ids still render
 * something sensible.
 *
 * @module llm/model-label
 */

import { findModel } from "./model-registry.ts"
import { findProviderPlugin } from "./provider-plugin.ts"

/** Provider short code for a model id (registry first, then a prefix heuristic). */
function providerShort(modelId: string): string {
  const providerId = findModel(modelId)?.providerId
  if (providerId) return findProviderPlugin(providerId)?.shortCode ?? providerId
  if (modelId.startsWith("claude")) return "anth"
  if (modelId.startsWith("gpt") || /^o\d/.test(modelId)) return "oai"
  return modelId.split(/[-.]/)[0] || "?"
}

/** Parse a compact version token from a model id. */
function versionToken(modelId: string): string {
  // Anthropic "claude-<tier>-<maj>-<min>[-date][1m]" → "maj.min".
  const claude = modelId.match(/^claude-(?:opus|sonnet|haiku)-(\d+)-(\d+)/)
  if (claude) return `${claude[1]}.${claude[2]}`
  // OpenAI "gpt-<rest>" → rest, minus a trailing date or "-chat" alias.
  const gpt = modelId.match(/^gpt-(.+)$/)
  if (gpt) return gpt[1].replace(/-\d{6,}.*$/, "").replace(/-chat$/, "")
  // o-series + anything else: the id minus a trailing date suffix.
  return modelId.replace(/-\d{6,}.*$/, "")
}

/**
 * Compact provider-tagged label for a model id, e.g. `anth-4.8`,
 * `oai-5.5`. Returns just the provider short code when no distinct
 * version token can be parsed, and `""` for an empty input.
 */
export function modelShortLabel(modelId: string): string {
  if (!modelId) return ""
  const short = providerShort(modelId)
  const version = versionToken(modelId)
  return version && version !== short ? `${short}-${version}` : short
}

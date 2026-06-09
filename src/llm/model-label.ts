/**
 * Compact provider-tagged model labels for dense UI (the footer,
 * `--list-models`).
 *
 * Maps a model id to `<shortCode>-<versionToken>`: the provider's
 * `shortCode` joined to a version token parsed by the provider's OWN
 * `modelVersionToken` hook (each plugin knows its naming scheme; core
 * doesn't — DIP, same shape as `mediaLimits`/`listLiveModels`).
 *
 * Unregistered ids degrade gracefully: the id's first dash/dot segment
 * becomes the provider tag and a generic date-suffix strip produces the
 * token, so forward-compat ids still render something sensible without
 * core hardcoding any vendor's scheme.
 *
 * @module llm/model-label
 */

import { findModel } from "./model-registry.ts"
import { findProviderPlugin, listProviderPlugins } from "./provider-plugin.ts"

/** Generic fallback token: the id minus a trailing date-ish suffix. */
function genericToken(modelId: string): string {
  return modelId.replace(/-\d{6,}.*$/, "")
}

/**
 * Compact provider-tagged label for a model id. Returns just the
 * provider short code when no distinct version token can be parsed,
 * and `""` for an empty input.
 */
export function modelShortLabel(modelId: string): string {
  if (!modelId) return ""

  // Registered id: its provider owns both the tag and the token scheme.
  const providerId = findModel(modelId)?.providerId
  if (providerId) {
    const plugin = findProviderPlugin(providerId)
    const short = plugin?.shortCode ?? providerId
    const version = plugin?.modelVersionToken?.(modelId) ?? genericToken(modelId)
    return version && version !== short ? `${short}-${version}` : short
  }

  // Unregistered id: ask every plugin whether the id matches its naming
  // scheme (pure string parse, no I/O), so live-API-only ids from a known
  // provider still label correctly. First match wins.
  for (const plugin of listProviderPlugins()) {
    const version = plugin.modelVersionToken?.(modelId)
    if (version !== undefined) {
      return version && version !== plugin.shortCode
        ? `${plugin.shortCode}-${version}`
        : plugin.shortCode
    }
  }

  // Unknown scheme entirely: generic tag + generic token. The token is
  // the whole id minus date suffixes, so strip the tag prefix to avoid
  // doubling it ("vendor-model-1" must not label as "vendor-vendor-model-1").
  const short = modelId.split(/[-.]/)[0] || "?"
  const version = genericToken(modelId).replace(new RegExp(`^${short}[-.]?`), "")
  return version && version !== short ? `${short}-${version}` : short
}

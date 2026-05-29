/**
 * Provider session-metadata resolver (the seam the status bar + startup use).
 *
 * Anything in the agent that needs per-session model metadata (quota windows,
 * context window, model label) calls {@link resolveProviderSessionInfo} and
 * gets a provider-neutral {@link ProviderSessionInfo}. The resolver routes to
 * the request model's provider plugin via the registry — no provider is named
 * by the agent — so a sub-agent running a different model/provider transparently
 * gets ITS provider's metadata.
 *
 * Degradation ladder (never throws):
 *   1. provider plugin with `fetchSessionInfo` → its result (or null).
 *   2. provider without the hook, or unknown model → context-only view
 *      synthesized from the model registry (context window + label), so the
 *      footer still shows the context bar.
 *
 * @module llm/provider-session
 */

import { modelShortLabel } from "./model-label.ts"
import { resolveModel } from "./model-registry.ts"
import { findProviderPlugin, type ProviderSessionInfo } from "./provider-plugin.ts"

/** Model context window (tokens) from the registry, or `undefined` if unknown. */
export function contextWindowForModel(modelId: string): number | undefined {
  try {
    return resolveModel(modelId).capabilities.contextWindow
  } catch {
    return undefined
  }
}

/**
 * Context-only metadata from the registry: what we can know about any model
 * without asking its provider (used as the fallback when a provider declares
 * no `fetchSessionInfo`, or fails, or the model is unknown).
 */
function contextOnly(modelId: string): ProviderSessionInfo {
  return {
    contextWindow: contextWindowForModel(modelId),
    modelLabel: modelShortLabel(modelId),
  }
}

/** Options for {@link resolveProviderSessionInfo}. */
export interface ResolveSessionInfoOptions {
  signal?: AbortSignal
  networkClient?: unknown
}

/**
 * Resolve provider-neutral session metadata for `modelId`. Delegates to the
 * model's provider plugin; falls back to a context-only view. Never throws.
 */
export async function resolveProviderSessionInfo(
  modelId: string,
  opts: ResolveSessionInfoOptions = {},
): Promise<ProviderSessionInfo> {
  let providerId: string | undefined
  try {
    providerId = resolveModel(modelId).providerId
  } catch {
    return contextOnly(modelId)
  }

  const plugin = findProviderPlugin(providerId)
  if (!plugin?.fetchSessionInfo) return contextOnly(modelId)

  try {
    const info = await plugin.fetchSessionInfo({
      modelId,
      signal: opts.signal,
      networkClient: opts.networkClient,
    })
    if (!info) return contextOnly(modelId)
    // Backfill anything the provider left blank from the registry, so the
    // context segment + label never go dark just because a provider only
    // cared about quota.
    return {
      contextWindow: info.contextWindow ?? contextWindowForModel(modelId),
      modelLabel: info.modelLabel ?? modelShortLabel(modelId),
      quota: info.quota,
    }
  } catch {
    return contextOnly(modelId)
  }
}

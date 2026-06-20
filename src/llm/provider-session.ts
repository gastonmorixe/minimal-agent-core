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
export function contextWindowForModel(modelId: string, providerId?: string): number | undefined {
  try {
    return resolveModel(modelId, providerId).capabilities?.contextWindow
  } catch {
    return undefined
  }
}

/**
 * Context-only metadata from the registry: what we can know about any model
 * without asking its provider (used as the fallback when a provider declares
 * no `fetchSessionInfo`, or fails, or the model is unknown).
 */
function contextOnly(modelId: string, providerId?: string): ProviderSessionInfo {
  return {
    contextWindow: contextWindowForModel(modelId, providerId),
    modelLabel: modelShortLabel(modelId, providerId),
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
 *
 * The provider's {@link ProviderPlugin.fetchSessionInfo} is expected to be
 * cache-only (no network) — cold-start cache population lives in
 * {@link primeProviderSessionInfo}.
 */
export async function resolveProviderSessionInfo(
  modelId: string,
  opts: ResolveSessionInfoOptions & { providerId?: string } = {},
): Promise<ProviderSessionInfo> {
  const providerId = opts.providerId
  let resolvedProviderId: string | undefined
  try {
    resolvedProviderId = resolveModel(modelId, providerId).providerId
  } catch {
    return contextOnly(modelId, providerId)
  }

  const plugin = findProviderPlugin(resolvedProviderId)
  if (!plugin?.fetchSessionInfo) return contextOnly(modelId, providerId)

  try {
    const info = await plugin.fetchSessionInfo({
      modelId,
      signal: opts.signal,
      networkClient: opts.networkClient,
    })
    if (!info) return contextOnly(modelId, providerId)
    return {
      contextWindow: info.contextWindow ?? contextWindowForModel(modelId, providerId),
      modelLabel: info.modelLabel ?? modelShortLabel(modelId, providerId),
      quota: info.quota,
    }
  } catch {
    return contextOnly(modelId, providerId)
  }
}

/**
 * Warm the selected provider's session-metadata cache. Routes to the
 * model's plugin's {@link ProviderPlugin.primeSessionInfo} (or no-ops
 * when the plugin doesn't declare one — providers whose cache fills from
 * chat traffic don't need a separate prime).
 *
 * Called fire-and-forget by the agent boot. Never throws — failures
 * degrade to "the status bar shows the manifest placeholder until real
 * traffic fills the cache", which is the same fallback as before the
 * prime hook existed.
 */
export async function primeProviderSessionInfo(
  modelId: string,
  opts: ResolveSessionInfoOptions & { providerId?: string } = {},
): Promise<void> {
  const providerId = opts.providerId
  let resolvedProviderId: string | undefined
  try {
    resolvedProviderId = resolveModel(modelId, providerId).providerId
  } catch {
    return
  }
  const plugin = findProviderPlugin(resolvedProviderId)
  if (!plugin?.primeSessionInfo) return
  try {
    await plugin.primeSessionInfo({
      modelId,
      signal: opts.signal,
      networkClient: opts.networkClient,
    })
  } catch {
    // best-effort; prime is a UX warm-up, not a correctness step.
  }
}

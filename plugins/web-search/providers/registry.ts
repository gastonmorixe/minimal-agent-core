/**
 * Provider registry + chain runner.
 *
 * Two responsibilities:
 *
 * 1. Map a provider id (`"brave"`) to a constructed `WebSearchProvider`,
 *    using the per-provider config block from `WebSearchConfig.providerConfigs`.
 *    Unknown ids are logged once and dropped.
 *
 * 2. `runChain(query, opts, providers, signal)` — try providers in order:
 *    skip `!isConfigured`, advance on thrown errors, return the first
 *    successful response (even when `hits.length === 0`). All exhausted →
 *    throw `WebSearchAllFailedError` carrying every provider's failure
 *    reason so the handler can render an actionable error.
 *
 * Adding a new provider is a one-line registry edit + one factory file.
 *
 * @module web-search/providers/registry
 */

import type { WebSearchConfig } from "../config.ts"

import { braveFactory } from "./brave.ts"
import type { ProviderFactory, SearchOptions, SearchResponse, WebSearchProvider } from "./types.ts"
import { WebSearchProviderError } from "./types.ts"

/**
 * Built-in provider factories. Add new providers here.
 *
 * Keys MUST match the ids users put in `plugins["web-search"].providers` and
 * the `id` field of the provider's class.
 */
export const BUILTIN_FACTORIES: Record<string, ProviderFactory> = {
  brave: braveFactory,
}

/**
 * Build the provider chain from config. Unknown ids are dropped (with a
 * warning when a logger is provided). Order is preserved.
 */
export function buildChain(
  config: WebSearchConfig,
  factories: Record<string, ProviderFactory> = BUILTIN_FACTORIES,
  logger?: (msg: string) => void,
): WebSearchProvider[] {
  const out: WebSearchProvider[] = []
  for (const id of config.providers) {
    const factory = factories[id]
    if (!factory) {
      logger?.(`unknown provider "${id}" — skipping`)
      continue
    }
    const cfg = config.providerConfigs[id] ?? {}
    out.push(factory(cfg))
  }
  return out
}

/** Per-provider failure reason recorded when the chain advances. */
export interface ChainFailure {
  providerId: string
  /** `"not_configured"` | `"error"` */
  kind: "not_configured" | "error"
  message: string
}

/**
 * Thrown when every provider in the chain refused or failed. Carries the
 * full per-provider trail so the caller can format a helpful error.
 */
export class WebSearchAllFailedError extends Error {
  constructor(public failures: ChainFailure[]) {
    const reasons = failures.length
      ? failures.map((f) => `${f.providerId}: ${f.message}`).join("; ")
      : "no providers configured"
    super(`web search failed: ${reasons}`)
    this.name = "WebSearchAllFailedError"
  }
}

/**
 * Run the chain. Returns the first provider's response (empty hits ARE
 * a valid result and stop the chain). Throws `WebSearchAllFailedError`
 * only when every provider was unusable.
 */
export async function runChain(
  query: string,
  opts: SearchOptions,
  providers: WebSearchProvider[],
  signal: AbortSignal,
  env: Record<string, string | undefined> = process.env,
  logger?: (msg: string) => void,
): Promise<SearchResponse> {
  const failures: ChainFailure[] = []
  for (const provider of providers) {
    if (!provider.isConfigured(env)) {
      failures.push({
        providerId: provider.id,
        kind: "not_configured",
        message: "not configured (missing API key)",
      })
      continue
    }
    try {
      return await provider.search(query, opts, signal)
    } catch (err) {
      const msg =
        err instanceof WebSearchProviderError
          ? err.message.replace(/^\[[^\]]+\]\s*/, "")
          : err instanceof Error
            ? err.message
            : String(err)
      failures.push({ providerId: provider.id, kind: "error", message: msg })
      logger?.(`provider "${provider.id}" failed: ${msg}`)
      // continue to next provider
    }
  }
  throw new WebSearchAllFailedError(failures)
}

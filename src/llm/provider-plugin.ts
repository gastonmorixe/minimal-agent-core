/**
 * Provider-plugin contract + registry.
 *
 * A `ProviderPlugin` is a self-describing unit that contributes ONE
 * provider (its `ProviderAdapter` + model catalog) to the canonical
 * registries when activated. It is the seam the composition root uses to
 * wire providers, so the agent entrypoint never names a provider by hand.
 *
 * This is the SAME shape each `plugins/llm-<id>/` package exports. The
 * provider loader (`provider-discovery.ts`) scans `plugins/llm-*` for a
 * `provider.json`, dynamically imports the declared `ProviderPlugin`, and
 * registers it here, so the core never imports a provider by name.
 *
 * @module llm/provider-plugin
 */

import type { ProviderAuth } from "./provider.ts"

/**
 * Context handed to a plugin's optional {@link ProviderPlugin.onStartupProbe}.
 * Provider-neutral: the composition root builds it once and passes it to
 * every registered plugin, so the entrypoint never special-cases a provider.
 */
export interface ProviderStartupContext {
  /** Resolved auth in provider-neutral form. */
  auth: ProviderAuth
  /** Selected model id, normalized (no `[1m]` / `[2m]` context suffix). */
  modelId: string
}

/**
 * A provider, packaged for registration. `register()` wires the adapter
 * and models into the canonical registries (it wraps the provider's
 * `bootstrap<Id>()`); it MUST be idempotent.
 */
export interface ProviderPlugin {
  /** Stable provider id, matching `ModelEntry.providerId` (`"anthropic"`, `"openai"`). */
  id: string
  /** Human-friendly name for diagnostics + `--list-models`. */
  displayName: string
  /** Compact tag for dense UI (e.g. footer): `"anth"`, `"oai"`. */
  shortCode: string
  /** Register this provider's adapter + model catalog. Idempotent. */
  register(): void
  /**
   * Optional fire-and-forget startup probe, run once after activation and
   * before the first request. Lets a provider overlay server-shipped data
   * onto the registry (e.g. Anthropic's `/bootstrap` model-cost overrides).
   * MUST NOT throw and MUST self-gate (e.g. no-op for the wrong auth kind);
   * failures are tolerated as a best-effort UX improvement. Keeping this on
   * the plugin is what lets `src/index.ts` start providers without naming
   * any of them.
   */
  onStartupProbe?(ctx: ProviderStartupContext): void
}

const plugins = new Map<string, ProviderPlugin>()

/** Add (or replace) a provider plugin. Does NOT activate it. */
export function registerProviderPlugin(plugin: ProviderPlugin): void {
  plugins.set(plugin.id, plugin)
}

/** Enumerate registered provider plugins. */
export function listProviderPlugins(): ProviderPlugin[] {
  return [...plugins.values()]
}

/** Look up a provider plugin by id (e.g. to map a model's providerId → shortCode). */
export function findProviderPlugin(id: string): ProviderPlugin | undefined {
  return plugins.get(id)
}

/**
 * Activate every registered provider plugin (calls each `register()`).
 * Idempotent because `register()` is. Returns the activated ids.
 */
export function activateProviderPlugins(): string[] {
  const activated: string[] = []
  for (const plugin of plugins.values()) {
    plugin.register()
    activated.push(plugin.id)
  }
  return activated
}

/** Drop all registered provider plugins. Tests only. */
export function clearProviderPlugins(): void {
  plugins.clear()
}

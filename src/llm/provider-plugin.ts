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

import type { ProviderPlugin } from "@minimal-agent/plugin-api/llm/provider-plugin"

/**
 * Wave D-1 split: the provider-plugin TYPE surface
 * (`ProviderStartupContext`, `LiveModelRow`, `SystemPromptBlock`,
 * `SystemPromptContext`, `QuotaWindow`, `QuotaSnapshot`, `ProviderSessionInfo`,
 * `ProviderSessionContext`, `ProviderPlugin`) plus the pure
 * {@link neutralSystemPrompt} resolver MOVED to the leaf contract package
 * `@minimal-agent/plugin-api/llm/provider-plugin` (provider-neutral, no host
 * state), so a plugin can depend on the contract without reaching into `src/`.
 *
 * The stateful provider REGISTRY below (`registerProviderPlugin` /
 * `listProviderPlugins` / `findProviderPlugin` / `activateProviderPlugins` /
 * `clearProviderPlugins`, backed by a module-level `Map`) is HOST STATE — it
 * must NOT live in a shared package (that would create two sources of truth) —
 * so it stays here. This re-export keeps the old `src/llm/provider-plugin.ts`
 * import path the single surface for core (and any not-yet-swept plugin).
 */
export type {
  ApiKeyAuthProvider,
  AuthCredentialDetail,
  AuthCredentialInfo,
  AuthSecretBag,
  AuthSecretValue,
  LiveModelRow,
  OAuthLoginConfig,
  OAuthLoginInstallResult,
  OAuthLoginProvider,
  ProviderPlugin,
  ProviderSessionContext,
  ProviderSessionInfo,
  ProviderStartupContext,
  QuotaSnapshot,
  QuotaWindow,
  SystemPromptBlock,
  SystemPromptContext,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
export { neutralSystemPrompt } from "@minimal-agent/plugin-api/llm/provider-plugin"

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

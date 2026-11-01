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

import type { ProviderPlugin } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

import { type Diagnostics, processDiagnostics } from "../diagnostics/hub.ts"

/**
 * Wave D-1 split: the provider-plugin TYPE surface
 * (`ProviderStartupContext`, `LiveModelRow`, `SystemPromptBlock`,
 * `SystemPromptContext`, `QuotaWindow`, `QuotaSnapshot`, `ProviderSessionInfo`,
 * `ProviderSessionContext`, `ProviderPlugin`) plus the pure
 * {@link neutralSystemPrompt} resolver MOVED to the leaf contract package
 * `@minimal-agent/core/plugin-api/llm/provider-plugin` (provider-neutral, no host
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
} from "@minimal-agent/core/plugin-api/llm/provider-plugin"
export { neutralSystemPrompt } from "@minimal-agent/core/plugin-api/llm/provider-plugin"

const plugins = new Map<string, ProviderPlugin>()

/** Add (or replace) a provider plugin. Does NOT activate it. */
export function registerProviderPlugin(plugin: ProviderPlugin): void {
  plugins.set(plugin.id, plugin)
}

/** Enumerate registered provider plugins. */
export function listProviderPlugins(): ProviderPlugin[] {
  return [...plugins.values()]
}

/** Former ids already warned about in this process (one warning each). */
const warnedFormerIds = new Set<string>()

/**
 * Look up a provider plugin by id (e.g. to map a model's providerId → shortCode).
 * An exact id wins. Else a plugin whose `formerIds` contains `id` is returned,
 * with a one-time deprecation warning on the diagnostic bus.
 */
export function findProviderPlugin(
  id: string,
  diagnostics: Diagnostics = processDiagnostics(),
): ProviderPlugin | undefined {
  const exact = plugins.get(id)
  if (exact) return exact
  for (const plugin of plugins.values()) {
    if (plugin.formerIds?.includes(id)) {
      warnFormerId(diagnostics, id, plugin.id)
      return plugin
    }
  }
  return undefined
}

/**
 * Map a provider id to its canonical id. A former id (see
 * `ProviderPlugin.formerIds`) maps to the renamed plugin id and warns once.
 * Unknown ids pass through unchanged, so callers keep their own
 * "unknown provider" errors.
 */
export function canonicalProviderId(
  id: string,
  diagnostics: Diagnostics = processDiagnostics(),
): string {
  return findProviderPlugin(id, diagnostics)?.id ?? id
}

function warnFormerId(diagnostics: Diagnostics, formerId: string, currentId: string): void {
  if (warnedFormerIds.has(formerId)) return
  warnedFormerIds.add(formerId)
  diagnostics.warn("provider.renamed", `provider "${formerId}" is now "${currentId}"`, {
    "former-id": formerId,
    "provider-id": currentId,
  })
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
  warnedFormerIds.clear()
}

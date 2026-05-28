/**
 * Built-in provider registry.
 *
 * The composition root activates providers through `activateBuiltinProviders()`
 * so the agent entrypoint (`src/index.ts`) never names a provider by hand:
 * adding or removing a provider is a one-line change HERE, not in the core.
 *
 * This barrel is the in-tree stand-in for plugin discovery. When the
 * providers move to `plugins/llm-<id>/` (see
 * `private/research/2026-05-28-llm-providers/`), the plugin loader will
 * discover those packages and register the exact same `ProviderPlugin`
 * contract; this file's list shrinks to whatever stays in-tree (likely
 * nothing).
 *
 * @module llm/providers
 */

import { anthropicProviderPlugin } from "../../../plugins/llm-anthropic/index.ts"
import { openaiProviderPlugin } from "../../../plugins/llm-openai/index.ts"
import { activateProviderPlugins, registerProviderPlugin } from "../provider-plugin.ts"

/** The in-tree provider plugins, in registration order. */
export const BUILTIN_PROVIDER_PLUGINS = [anthropicProviderPlugin, openaiProviderPlugin] as const

/**
 * Register + activate the built-in providers (Anthropic, OpenAI).
 * Idempotent: `registerProviderPlugin` de-dupes by id and each
 * provider's `register()` is itself idempotent. Returns the activated
 * provider ids.
 */
export function activateBuiltinProviders(): string[] {
  for (const plugin of BUILTIN_PROVIDER_PLUGINS) registerProviderPlugin(plugin)
  return activateProviderPlugins()
}

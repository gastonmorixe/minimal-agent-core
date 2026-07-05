/**
 * Early provider-plugin discovery for startup.
 *
 * Provider plugins (`plugins/llm-*`) must be registered before any boot-model,
 * auth, quota, or canonical-run logic touches the model registry. This is
 * separate from the later TUI {@link PluginLoader}, which loads tools, modes,
 * prompts, and live-area slots.
 *
 * @module host/startup/provider-discovery-boot
 */

import { join } from "node:path"

import { activateDiscoveredProviders, registerDiscoveredProviders } from "../../llm/index.ts"
import { resolveSiblingPluginRoots } from "../../plugins/loader/helpers.ts"

/** Register provider plugins from embedded and dev-time sibling roots. */
export async function bootProviderDiscovery(providerEmbeddedDir: string): Promise<void> {
  await registerDiscoveredProviders([
    join(providerEmbeddedDir, "plugins"),
    ...resolveSiblingPluginRoots(providerEmbeddedDir),
  ])
  activateDiscoveredProviders()
}

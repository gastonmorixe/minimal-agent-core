/**
 * Early provider-plugin discovery for startup.
 *
 * Provider plugins (`llm-*` packages carrying a `provider.json`) must be
 * registered before any boot-model, auth, quota, or canonical-run logic touches
 * the model registry. This is separate from the later {@link PluginLoader},
 * which loads tools, modes, and prompts.
 *
 * The host computes the roots (S40). Core knows no default plugin location.
 *
 * @module runtime/provider-discovery-boot
 */

import { activateDiscoveredProviders, registerDiscoveredProviders } from "../llm/index.ts"

/** Inputs for {@link bootProviderDiscovery}. */
export interface BootProviderDiscoveryInput {
  /**
   * Provider plugin roots, computed by the host. Each directory holds
   * provider package directories directly. Order sets id-collision
   * precedence: {@link registerDiscoveredProviders} keeps the FIRST copy of
   * each provider id. A missing directory contributes nothing.
   * `providerRootsOf(roots)` (`./host-kit/plugin-loader`) gives this list
   * from the manifest-plugin roots.
   */
  readonly roots: readonly string[]
}

/** Register and activate provider plugins from the host-computed roots. */
export async function bootProviderDiscovery(input: BootProviderDiscoveryInput): Promise<void> {
  await registerDiscoveredProviders(input.roots)
  activateDiscoveredProviders()
}

/**
 * Early provider-plugin discovery for startup.
 *
 * Provider plugins (`llm-*` packages carrying a `provider.json`) must be
 * registered before any boot-model, auth, quota, or canonical-run logic touches
 * the model registry. This is separate from the later TUI {@link PluginLoader},
 * which loads tools, modes, prompts, and live-area slots.
 *
 * @module host/startup/provider-discovery-boot
 */

import { join } from "node:path"

import { activateDiscoveredProviders, registerDiscoveredProviders } from "../../llm/index.ts"
import { resolveSiblingPluginRoots } from "../../plugins/loader/helpers.ts"

/** Inputs for {@link bootProviderDiscovery}. */
export interface BootProviderDiscoveryInput {
  /** The agent install dir (`<repo>`, parent of `src/`). Hosts `<repo>/plugins`. */
  readonly embeddedDir: string
  /**
   * The resolved per-user agent home (`~/.minimal-agent`). Provider plugins are
   * git-cloned into `<userDir>/plugins` on first run, so this root MUST be
   * scanned or an installed box (no embedded providers, no dev sibling) finds
   * zero providers and cannot resolve a model or sign in. Undefined only when
   * the home cannot be resolved.
   */
  readonly userDir?: string
}

/**
 * Compute the ordered provider-plugin roots to scan.
 *
 * Order determines id-collision precedence: {@link registerDiscoveredProviders}
 * keeps the FIRST occurrence of each provider id. The order is:
 *
 *   1. `<embeddedDir>/plugins`     — providers shipped inside the checkout.
 *   2. dev-time sibling roots      — `../minimal-agent-plugins` when present,
 *      so a developer's working copy shadows an auto-cloned one.
 *   3. `<userDir>/plugins`         — the first-run clone target on an installed
 *      box. This is where providers actually live in production, so omitting it
 *      leaves a fresh install with `0 models available`.
 *
 * A missing/undefined root contributes nothing (the discovery layer treats a
 * non-existent directory as empty).
 *
 * @param embeddedDir - the agent install dir (`<repo>`, parent of `src/`).
 * @param userDir - the per-user agent home (`~/.minimal-agent`), or undefined.
 */
export function resolveProviderPluginRoots(embeddedDir: string, userDir?: string): string[] {
  const roots = [join(embeddedDir, "plugins"), ...resolveSiblingPluginRoots(embeddedDir)]
  if (userDir) roots.push(join(userDir, "plugins"))
  return roots
}

/** Register + activate provider plugins from embedded, sibling, and user roots. */
export async function bootProviderDiscovery(input: BootProviderDiscoveryInput): Promise<void> {
  await registerDiscoveredProviders(resolveProviderPluginRoots(input.embeddedDir, input.userDir))
  activateDiscoveredProviders()
}

/**
 * The text step of the plugin loader boot, after every plugin package is
 * loaded and the tool result chain boots: the synthetic text providers and
 * their resolver, and the built-in tool text providers. Split out of
 * `loader.ts` to keep that file under the line limit. The boot contract check
 * runs before the chain boot (see `runContractCheck`), so a `fail` mode check
 * throws before any transform or codec module import.
 *
 * @module plugins/loader/text-boot
 */

import type { ToolTextProvider } from "../../../plugin-api/src/types/tool-text.ts"
import type { Diagnostics } from "../../diagnostics/hub.ts"
import type { SidebandApi } from "../../sideband/types.ts"
import type { LoadedPlugin } from "../types.ts"

import { buildSyntheticText, type SyntheticTextHolder } from "./synthetic-text.ts"
import { collectToolTextProviders } from "./tool-text.ts"

/** The text of the loaded plugins. */
export interface LoadedText {
  readonly synthetic: SyntheticTextHolder
  readonly toolText: readonly ToolTextProvider[]
}

/**
 * Collect the text providers of the loaded plugins. A contract that a closer
 * tier overrides is not taken from a farther plugin.
 *
 * @param plugins - The loaded plugins, in load order.
 * @param relay - Where the diagnostics go.
 * @param overridden - Per package dir, the contracts a closer tier owns.
 * @param sideband - The sideband API that the resolver gives to each provider.
 * @returns The text providers.
 */
export async function loadPluginText(
  plugins: readonly LoadedPlugin[],
  relay: Diagnostics,
  overridden: ReadonlyMap<string, ReadonlySet<string>>,
  sideband?: SidebandApi,
): Promise<LoadedText> {
  const sb = sideband && (() => sideband)
  const synthetic = await buildSyntheticText(plugins, relay, overridden, sb)
  const toolText = await collectToolTextProviders(plugins, relay, overridden)
  return { synthetic, toolText }
}

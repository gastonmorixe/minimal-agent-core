/**
 * The text step of the plugin loader boot, after every plugin package is
 * loaded: the synthetic text providers and their resolver, the built-in tool
 * text providers, and the boot contract check. Split out of `loader.ts` to
 * keep that file under the line limit.
 *
 * @module plugins/loader/text-boot
 */

import type { ToolTextProvider } from "../../../plugin-api/src/types/tool-text.ts"
import type { Diagnostics } from "../../diagnostics/hub.ts"
import type { LoadedPlugin } from "../types.ts"

import { type ContractCheckResult, runContractCheck } from "./contract-owners.ts"
import { buildSyntheticText, type SyntheticTextHolder } from "./synthetic-text.ts"
import { collectToolTextProviders } from "./tool-text.ts"

/** The text of the loaded plugins and the contract check result. */
export interface LoadedText {
  readonly synthetic: SyntheticTextHolder
  readonly toolText: readonly ToolTextProvider[]
  /** Undefined when the check did not run (`allowBareCore` with no plugins). */
  readonly contractCheck: ContractCheckResult | undefined
}

/**
 * Collect the text providers of the loaded plugins and run the contract check.
 * A contract that a closer tier overrides is not taken from a farther plugin.
 *
 * @param plugins - The loaded plugins, in load order.
 * @param opts - The loader options of the contract check.
 * @param relay - Where the diagnostics go.
 * @param overridden - Per package dir, the contracts a closer tier owns.
 * @returns The text providers and the check result.
 */
export async function loadPluginText(
  plugins: readonly LoadedPlugin[],
  opts: Parameters<typeof runContractCheck>[1],
  relay: Diagnostics,
  overridden: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<LoadedText> {
  const synthetic = await buildSyntheticText(plugins, relay, overridden)
  const toolText = await collectToolTextProviders(plugins, relay, overridden)
  return { synthetic, toolText, contractCheck: runContractCheck(plugins, opts, relay) }
}

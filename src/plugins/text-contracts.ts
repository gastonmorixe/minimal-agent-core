/**
 * The text contracts a host requires at boot (R-BOOT, P3.5). Core holds no
 * text, so a host that boots without the text plugins would send empty
 * text. A host passes {@link TEXT_CONTRACTS} as `requiredContracts` and the
 * boot refuses to start when one has no provider. Identifiers only.
 *
 * @module plugins/text-contracts
 */

import { SYNTHETIC_KINDS, type SyntheticKind } from "../../plugin-api/src/types/synthetic-text.ts"

/** The system prompt contracts: the identity and the 3 base slots. */
export const SYSTEM_TEXT_CONTRACTS = [
  "text.system.identity",
  "text.system.instructions",
  "text.system.loopSafety",
  "text.system.toolOutputConventions",
] as const

/** The built-in tool text contract (`toolText` manifest entries). */
export const TOOL_TEXT_CONTRACT = "text.tools"

/** The prompt template contract (`%%name%%` fill of plugin prompt files). */
export const TEMPLATE_CONTRACT = "prompts.template"

/**
 * Synthetic kinds with no production call site in core. They are not
 * required: a missing owner never empties a request.
 *
 * Rule: a kind with a core call site is required. A new kind with no call
 * site yet goes here until core calls it.
 *
 * The 3 `compact.*` kinds left this list in 15d.4 (spec Q11), and
 * `tool_result.non_tool_result` and `tool_result.invalid_input` in 15e.1a:
 * core calls them, so they are required. The list is empty now.
 */
export const UNREQUIRED_SYNTHETIC_KINDS: readonly SyntheticKind[] = []

/** The synthetic kinds that have a core call site. */
export const REQUIRED_SYNTHETIC_KINDS: readonly SyntheticKind[] = SYNTHETIC_KINDS.filter(
  (k) => !UNREQUIRED_SYNTHETIC_KINDS.includes(k),
)

/** The contract id of one synthetic kind. */
export const syntheticContract = (kind: string): string => `synthetic:${kind}`

/** The contract id of one system prompt slot (or `identity`). */
export const systemContract = (slot: string): string => `text.system.${slot}`

/** Every text contract a host requires. Data only. */
export const TEXT_CONTRACTS: readonly string[] = Object.freeze([
  ...SYSTEM_TEXT_CONTRACTS,
  TOOL_TEXT_CONTRACT,
  TEMPLATE_CONTRACT,
  ...REQUIRED_SYNTHETIC_KINDS.map(syntheticContract),
])

/**
 * Is `contract` a text contract? Text contracts follow the tier rule: a
 * closer root tier overrides a farther one (F2).
 */
export function isTextContract(contract: string): boolean {
  return contract.startsWith("synthetic:") || contract.startsWith("text.")
}

/** A plugin root tier, as {@link LoadedPlugin.root} names it. */
export type RootTier = "embedded" | "user" | "home" | "project"

/** Precedence of a root tier: higher is closer to the user and wins. */
export function rootRank(root: RootTier | undefined): number {
  switch (root) {
    case "project":
      return 3
    case "user":
    case "home":
      return 2
    case "embedded":
      return 1
    default:
      return 0
  }
}

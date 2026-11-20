/**
 * Contract owners and the boot contract check (G11, R-BOOT, F2).
 *
 * Tier rule for text contracts (`synthetic:<kind>`, `text.*`): the closest
 * root tier that provides a contract owns it (project, then user, then
 * embedded). A provider in a farther tier is overridden: it does not get the
 * contract and one `synthetic.kind_overridden` diagnostic records it. Two
 * providers in the owning tier are a duplicate. Any other contract counts
 * every provider. Identifiers only, core holds no text.
 *
 * @module plugins/loader/contract-owners
 */

import type { Diagnostics } from "../../diagnostics/hub.ts"
import { ContractCheckFailedError } from "../../errors/contract-check.ts"
import { isTextContract, rootRank } from "../text-contracts.ts"
import type { LoadedPlugin } from "../types.ts"

/** Prefix of the contracts derived from `sideband[].kind` (existence only, see {@link checkRequiredContracts}). */
export const SIDEBAND_CONTRACT_PREFIX = "sideband:"

/** The result of one contract check. Ids only. */
export interface ContractCheckResult {
  /** Checked contracts with no provider, in check order. */
  readonly missing: readonly string[]
  /** Checked contracts with two or more providers in the owning tier. */
  readonly duplicates: readonly string[]
}

/** An empty result: nothing missing, nothing duplicated. */
export const CONTRACT_CHECK_PASSED: ContractCheckResult = Object.freeze({
  missing: Object.freeze([]) as readonly string[],
  duplicates: Object.freeze([]) as readonly string[],
})

/** The owners of every provided contract, after the tier rule. */
export interface ContractOwners {
  /** Plugin ids that own each contract (more than one is a duplicate). */
  readonly owners: ReadonlyMap<string, readonly string[]>
  /** Per package dir: the contracts it declares but a closer tier owns. */
  readonly overridden: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Apply the tier rule to the `provides` of `plugins`. Records one
 * `synthetic.kind_overridden` diagnostic per overridden text contract, with
 * the owner ids and the overridden ids (none when `diagnostics` is absent).
 */
export function resolveContractOwners(
  plugins: readonly LoadedPlugin[],
  diagnostics?: Diagnostics,
): ContractOwners {
  const byContract = new Map<string, LoadedPlugin[]>()
  for (const p of plugins) {
    for (const c of p.manifest.provides ?? []) {
      const list = byContract.get(c) ?? []
      if (!list.includes(p)) list.push(p)
      byContract.set(c, list)
    }
  }
  const owners = new Map<string, readonly string[]>()
  const overridden = new Map<string, Set<string>>()
  for (const [contract, providers] of byContract) {
    if (!isTextContract(contract)) {
      owners.set(
        contract,
        providers.map((p) => p.manifest.id),
      )
      continue
    }
    const top = Math.max(...providers.map((p) => rootRank(p.root)))
    const won = providers.filter((p) => rootRank(p.root) === top)
    const lost = providers.filter((p) => rootRank(p.root) !== top)
    owners.set(
      contract,
      won.map((p) => p.manifest.id),
    )
    if (lost.length === 0) continue
    for (const p of lost) {
      const set = overridden.get(p.packageDir) ?? new Set<string>()
      set.add(contract)
      overridden.set(p.packageDir, set)
    }
    diagnostics?.notice("synthetic.kind_overridden", "", {
      contract,
      owners: won.map((p) => p.manifest.id).join(","),
      overridden: lost.map((p) => p.manifest.id).join(","),
    })
  }
  return { owners, overridden }
}

/**
 * G11 contract check. The checked list is `extra` plus every contract that a
 * `required` plugin provides. A contract with no owner is missing. A
 * contract with two or more owners (after the tier rule) is a duplicate.
 * Records one `boot.contract_missing` or `boot.contract_duplicate` warning
 * per failure (data only) and returns the result. Never throws.
 *
 * A `sideband:<kind>` contract only proves that a required kind exists: it
 * can be missing, but it is never a duplicate. Two plugins with one kind
 * stay a `sideband.kind-rejected` diagnostic of the sideband registry.
 */
export function checkRequiredContracts(
  plugins: readonly LoadedPlugin[],
  extra: readonly string[],
  owners: ContractOwners,
  diagnostics: Diagnostics,
): ContractCheckResult {
  const contracts = new Set<string>(extra)
  for (const p of plugins) {
    if (p.manifest.required === true) for (const c of p.manifest.provides ?? []) contracts.add(c)
  }
  const missing: string[] = []
  const duplicates: string[] = []
  for (const contract of contracts) {
    const ids = owners.owners.get(contract) ?? []
    if (ids.length === 0) {
      missing.push(contract)
      diagnostics.warn("boot.contract_missing", "", { contract })
    } else if (ids.length > 1 && !contract.startsWith(SIDEBAND_CONTRACT_PREFIX)) {
      duplicates.push(contract)
      diagnostics.warn("boot.contract_duplicate", "", { contract, providers: ids.join(",") })
    }
  }
  return { missing, duplicates }
}

/** Throw {@link ContractCheckFailedError} when `result` has a failure. */
export function assertContractCheck(result: ContractCheckResult): void {
  if (result.missing.length > 0 || result.duplicates.length > 0) {
    throw new ContractCheckFailedError(result.missing, result.duplicates)
  }
}

/**
 * Run the boot contract check of one load. Skipped (undefined) for a bare
 * boot: `allowBareCore` with zero plugins. In `fail` mode a failed check
 * throws {@link ContractCheckFailedError}.
 */
export function runContractCheck(
  plugins: readonly LoadedPlugin[],
  opts: {
    readonly requiredContracts?: readonly string[]
    readonly allowBareCore?: boolean
    readonly contractCheckMode?: "warn" | "fail"
  },
  diagnostics: Diagnostics,
): ContractCheckResult | undefined {
  if (opts.allowBareCore === true && plugins.length === 0) return undefined
  const owners = resolveContractOwners(plugins)
  const result = checkRequiredContracts(plugins, opts.requiredContracts ?? [], owners, diagnostics)
  if (opts.contractCheckMode === "fail") assertContractCheck(result)
  return result
}

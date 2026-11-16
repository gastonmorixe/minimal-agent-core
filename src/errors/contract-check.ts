/**
 * Boot contract check failure (R-BOOT-1, R-BOOT-2). Holds the failed
 * contract ids as data and no text. The host renders it.
 *
 * @module errors/contract-check
 */

import { CoreError } from "./core-error.ts"

/**
 * The boot refused to start: a required contract has no provider, or two
 * providers in the same root tier.
 */
export class ContractCheckFailedError extends CoreError {
  static readonly kind = "ContractCheckFailedError"
  declare readonly kind: "ContractCheckFailedError"
  /** Required contract ids with no provider, in check order. */
  readonly missing: readonly string[]
  /** Required contract ids with two or more providers in the winning tier. */
  readonly duplicates: readonly string[]

  constructor(
    missing: readonly string[],
    duplicates: readonly string[],
    options?: { cause?: unknown },
  ) {
    super(options)
    this.missing = Object.freeze([...missing])
    this.duplicates = Object.freeze([...duplicates])
  }
}

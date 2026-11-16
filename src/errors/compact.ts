/**
 * Compaction errors (spec R-ERR-5, C25). They hold facts and no text: a
 * host renders them.
 *
 * @module errors/compact
 */

import { CoreError } from "./core-error.ts"

/**
 * Local compaction was refused: no plugin gave `compact.summary_system`
 * text (bare core, a provider that threw, or a provider that returned "").
 * Core throws it before the summary request. The history is unchanged.
 */
export class CompactNoProviderError extends CoreError {
  static readonly kind = "CompactNoProviderError"
  declare readonly kind: "CompactNoProviderError"

  constructor(readonly mode: "local") {
    super()
  }
}

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

/**
 * A compaction of the same history is already in progress (row c3). Core
 * throws it before any work. The history is unchanged.
 */
export class CompactBusyError extends CoreError {
  static readonly kind = "CompactBusyError"
  declare readonly kind: "CompactBusyError"
}

/**
 * The live history changed while the compaction ran (row c4). Core throws it
 * before the commit. The history keeps the change and is not compacted.
 */
export class CompactRaceError extends CoreError {
  static readonly kind = "CompactRaceError"
  declare readonly kind: "CompactRaceError"
}

/**
 * The runner has no implementation of the compaction mode (row c5). Today
 * only `fork`. The history is unchanged.
 */
export class CompactModeUnsupportedError extends CoreError {
  static readonly kind = "CompactModeUnsupportedError"
  declare readonly kind: "CompactModeUnsupportedError"

  constructor(readonly mode: "fork") {
    super()
  }
}

/**
 * The `message.willSend` port threw for a compaction request (row c9). It
 * fails closed: the caller uses the stub. Only the error name is kept,
 * because the listener message can quote payload text.
 */
export class CompactSendPolicyError extends CoreError {
  static readonly kind = "CompactSendPolicyError"
  declare readonly kind: "CompactSendPolicyError"

  constructor(readonly errorName: string) {
    super()
  }
}

/** The fields of a {@link CompactSummaryStreamError}. */
export interface CompactSummaryStreamFacts {
  /** The `retryable` flag of the provider `stream_error` event. */
  readonly retryable: boolean
  /** The provider category of the stream error, when known. */
  readonly category?: string
  /** The raw provider error type, when known. */
  readonly upstreamType?: string
  /** The message of the stream error cause, when there is one. */
  readonly detail?: string
  /** 401 when the cause names HTTP 401 (the compact auth recovery reads it). */
  readonly status?: 401
}

/**
 * The local summary stream sent a `stream_error` event (row c8). The
 * `retryable` field is the retry flag that the retry classifier reads.
 */
export class CompactSummaryStreamError extends CoreError {
  static readonly kind = "CompactSummaryStreamError"
  declare readonly kind: "CompactSummaryStreamError"
  readonly retryable: boolean
  // `declare`: no own key is defined when a fact is absent (ESNext define
  // semantics would add each one as an own key with value undefined).
  declare readonly category?: string
  declare readonly upstreamType?: string
  declare readonly detail?: string
  declare readonly status?: 401

  constructor(facts: CompactSummaryStreamFacts, options?: { cause?: unknown }) {
    super(options)
    this.retryable = facts.retryable
    if (facts.category !== undefined) this.category = facts.category
    if (facts.upstreamType !== undefined) this.upstreamType = facts.upstreamType
    if (facts.detail !== undefined && facts.detail !== "") this.detail = facts.detail
    if (facts.status !== undefined) this.status = facts.status
  }
}

/**
 * The wrap-up abort reason.
 *
 * A host that must stop a run soon (for example a headless worker that got
 * SIGTERM) aborts the turn signal with a {@link WrapUpReason}, not with a
 * user abort. The agent loop then sends one last short request (see
 * `sdk/wrap-up.ts`). {@link withRetry} stops at once with a typed
 * {@link WrapUpAbortError}. It does not retry and does not wait.
 *
 * @module llm/transport/wrap-up-abort
 */

/** The abort `reason` of a wrap-up request. The host can set the final turn here. */
export interface WrapUpReason {
  readonly kind: "wrap_up"
  /**
   * The only tool names that the final request advertises. Names that the
   * run does not advertise are ignored. Omitted or no match: all tools of
   * the run stay.
   */
  readonly tools?: readonly string[]
  /**
   * The runtime note for the final turn. Core holds no model text: without
   * it, the final request has no note.
   */
  readonly text?: string
  /**
   * The wall-clock time (epoch ms) when the host ends the process. The
   * final turn ends before it: its budget is the smaller of
   * `WRAP_UP_DEADLINE_MS` and `deadlineAt - now` (see `sdk/wrap-up.ts`).
   * Omitted: the final turn gets `WRAP_UP_DEADLINE_MS`.
   */
  readonly deadlineAt?: number
}

/** A wrap-up reason with no options. */
export const WRAP_UP_REASON: WrapUpReason = Object.freeze({ kind: "wrap_up" as const })

/** True when an abort reason comes from a wrap-up request. */
export function isWrapUpReason(reason: unknown): reason is WrapUpReason {
  return (reason as { kind?: unknown } | null)?.kind === "wrap_up"
}

/** True when `signal` aborted because of a wrap-up request. */
export function isWrapUpAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && isWrapUpReason(signal.reason)
}

/** {@link withRetry} ended because of a wrap-up request. It is not a user abort. */
export class WrapUpAbortError extends Error {
  readonly kind = "wrap_up"
  constructor() {
    super("wrap_up")
    this.name = "WrapUpAbortError"
  }
}

/**
 * Structured progress for a single LLM stream attempt, used to decide how to
 * recover from a terminal-less stream close (`stream_closed_without_terminal`).
 *
 * Completed tool calls are the safety boundary: once any tool_use is fully
 * assembled and closed, the original request body must never be replayed
 * (tools may already have side effects once the agent executes them, and even
 * before that the local transcript will diverge from a byte-identical resend).
 *
 * @module llm/transport/attempt-progress
 */

/** Snapshot of what a stream attempt produced before it failed or closed. */
export type AttemptProgress = {
  /** True if any thinking/reasoning channel event was observed. */
  sawReasoning: boolean
  /** True if any assistant text (or refusal text) was observed. */
  sawText: boolean
  /**
   * Number of fully closed tool_use blocks (`tool_use_stop` after a start).
   * A partial `tool_use_input_delta` without stop does NOT count.
   */
  completedToolCalls: number
  /** Most recent canonical event type observed (for diagnostics). */
  lastEventType?: string
  /** Provider response id from `message_start`, when known. */
  responseId?: string
}

/** Empty progress for a brand-new attempt. */
export const ZERO_ATTEMPT_PROGRESS: AttemptProgress = {
  sawReasoning: false,
  sawText: false,
  completedToolCalls: 0,
}

/**
 * At most one short transport retry for terminal-less closes that had no
 * completed tool call (no output, or reasoning-only).
 */
export const MAX_PRE_EFFECT_TERMINALLESS_RETRIES = 1

/**
 * Short base delay for the one safe pre-effect terminal-less retry.
 * Intentionally NOT the 30s rate-limit curve.
 */
export const TERMINALLESS_RETRY_BASE_DELAY_MS = 200

/**
 * Recovery decision for a tagged stream failure. Pure policy: no I/O.
 *
 * - `retryTransport`: sleep then call `makeAttempt` again (same logical request).
 * - `failTurn`: stop retrying; propagate the error (or let the bridge salvage).
 * - `continueTurn`: do not resend; the caller must continue from local state
 *   (used when the bridge already salvaged completed tools — retry must not run).
 */
export type RecoveryDecision =
  | {
      kind: "retryTransport"
      delayMs: number
      /**
       * Whether the network layer should retire the H2 origin session before
       * the retry. **Unsupported today**: `Http2Transport` has no public
       * origin-eviction API for healthy sessions (only poison on abort /
       * goaway). Always `false` until that plumbing exists. Do not treat this
       * field as behavioral.
       */
      freshConnection: boolean
    }
  | { kind: "continueTurn"; reason: "terminalLessClose" }
  | { kind: "failTurn"; reason: string }

export type TerminalLessRecoveryInput = {
  progress: AttemptProgress | undefined
  /** How many times we have already retried this terminal-less error in this send. */
  priorTerminalLessRetries: number
  /** Jitter factor in [0, 1]; inject 0 in tests for determinism. */
  jitter?: number
}

/**
 * Decide recovery for `stream_closed_without_terminal`.
 *
 * Critical invariant: if `completedToolCalls > 0`, never `retryTransport`
 * (that would replay a post-tool / post-complete-tool-call request body).
 */
export function decideTerminalLessRecovery(input: TerminalLessRecoveryInput): RecoveryDecision {
  const progress = input.progress ?? ZERO_ATTEMPT_PROGRESS
  if (progress.completedToolCalls > 0) {
    return { kind: "continueTurn", reason: "terminalLessClose" }
  }
  if (input.priorTerminalLessRetries >= MAX_PRE_EFFECT_TERMINALLESS_RETRIES) {
    return {
      kind: "failTurn",
      reason:
        progress.sawText || progress.sawReasoning
          ? "terminal-less close after bounded pre-effect retry (partial output preserved upstream when possible)"
          : "terminal-less close after bounded pre-effect retry (no output)",
    }
  }
  const jitter = input.jitter ?? Math.random()
  const delayMs = Math.floor(jitter * TERMINALLESS_RETRY_BASE_DELAY_MS)
  return {
    kind: "retryTransport",
    delayMs,
    // Explicitly unsupported: no origin-session eviction is wired into retry.
    // PLAN §5 is optional; leave false so we never claim a behavior we lack.
    freshConnection: false,
  }
}

/** Read attempt progress from a thrown error, if the bridge attached it. */
export function readAttemptProgress(err: unknown): AttemptProgress | undefined {
  const p = (err as { attemptProgress?: AttemptProgress } | null)?.attemptProgress
  if (!p || typeof p !== "object") return undefined
  return p
}

/** Attach attempt progress onto an Error (mutates and returns the same error). */
export function attachAttemptProgress<E extends Error>(err: E, progress: AttemptProgress): E {
  return Object.assign(err, { attemptProgress: progress })
}

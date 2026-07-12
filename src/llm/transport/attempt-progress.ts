/**
 * Structured progress for a single LLM stream attempt, used to decide how to
 * recover from a terminal-less stream close (`stream_closed_without_terminal`).
 *
 * # Harness principle: never give up on transport
 *
 * Pre-effect closes (no completed tools) are safe to resend and MUST retry
 * forever with polite capped backoff — the agent is built for multi-day /
 * multi-week agentic runs and must not stop waiting for a human to re-prompt
 * after a Grok/OpenAI SSE EOF. Only the caller's AbortSignal (Esc / Ctrl-C)
 * ends the loop.
 *
 * # Completed tools: never re-POST
 *
 * Completed tool calls are the safety boundary: once any tool_use is fully
 * assembled and closed, the original request body must never be replayed
 * (tools may already have side effects once the agent executes them, and even
 * before that the local transcript will diverge from a byte-identical resend).
 * That path is `continueTurn` (salvage), not transport retry.
 *
 * # Mid-stream politeness (session 113921b7)
 *
 * Mid-reasoning closes use a multi-second floor so we do not thrash a provider
 * that is still thinking with 0ms re-POSTs. Empty closes may use a shorter
 * base, still forever, still capped.
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
 * Short base delay for empty pre-effect terminal-less retries (no progress).
 * Forever-retry with this curve; not a max-attempt budget.
 */
export const TERMINALLESS_RETRY_BASE_DELAY_MS = 200

/**
 * Base delay for mid-stream (reasoning/text progress, no completed tools)
 * terminal-less retries. Long enough that a provider still thinking is not
 * immediately re-POSTed; jittered and exponential in {@link decideTerminalLessRecovery}.
 */
export const TERMINALLESS_MIDSTREAM_RETRY_BASE_DELAY_MS = 2_000

/**
 * Cap for terminal-less pre-effect backoff. Matches the forever-retry max on
 * ordinary transport errors (5 min) so multi-day outages stay polite.
 */
export const TERMINALLESS_RETRY_MAX_DELAY_MS = 5 * 60_000

/**
 * @deprecated No max-attempt budget remains (never-give-up). Kept as a large
 * sentinel so older imports compile; policy no longer uses it to failTurn.
 */
export const MAX_EMPTY_TERMINALLESS_RETRIES = Number.POSITIVE_INFINITY

/**
 * @deprecated No max-attempt budget remains (never-give-up). Kept as a large
 * sentinel so older imports compile; policy no longer uses it to failTurn.
 */
export const MAX_MIDSTREAM_TERMINALLESS_RETRIES = Number.POSITIVE_INFINITY

/**
 * @deprecated Prefer the forever-retry policy. Alias of empty sentinel.
 */
export const MAX_PRE_EFFECT_TERMINALLESS_RETRIES = MAX_EMPTY_TERMINALLESS_RETRIES

/**
 * Recovery decision for a tagged stream failure. Pure policy: no I/O.
 *
 * - `retryTransport`: sleep then call `makeAttempt` again (same logical request).
 *   Forever for pre-effect closes (empty / mid-reasoning). Only user abort stops.
 * - `continueTurn`: do not resend; the caller must continue from local state
 *   (used when the bridge already salvaged completed tools — retry must not run).
 * - `failTurn`: reserved; terminal-less recovery never returns this under the
 *   never-give-up harness principle. Kept for type stability / future use.
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
      /** Which delay curve produced `delayMs` (diagnostics only). */
      curve: "terminal-less-empty" | "terminal-less-midstream"
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
 *
 * Pre-effect policy (never give up):
 * - empty stream → forever short exponential backoff (capped)
 * - saw reasoning and/or text (no completed tools) → forever multi-second
 *   exponential backoff with a floor so jitter cannot collapse to 0.0s
 *
 * No `failTurn` path: only Esc / AbortSignal stops the agent.
 */
export function decideTerminalLessRecovery(input: TerminalLessRecoveryInput): RecoveryDecision {
  const progress = input.progress ?? ZERO_ATTEMPT_PROGRESS
  if (progress.completedToolCalls > 0) {
    return { kind: "continueTurn", reason: "terminalLessClose" }
  }

  const midstream = progress.sawReasoning || progress.sawText
  const jitter = input.jitter ?? Math.random()
  // Cap exponent so 2^exp cannot overflow; delay is also min'd with max.
  const exp = Math.min(Math.max(0, input.priorTerminalLessRetries), 16)

  if (!midstream) {
    const ideal = Math.min(
      TERMINALLESS_RETRY_MAX_DELAY_MS,
      TERMINALLESS_RETRY_BASE_DELAY_MS * 2 ** exp,
    )
    // Tiny floor so we never spin at 0ms forever on Math.random=0 in tests
    // after the first few attempts; first attempt may still be 0 with jitter=0.
    const floor = input.priorTerminalLessRetries === 0 ? 0 : 50
    const delayMs = floor + Math.floor(jitter * Math.max(0, ideal - floor))
    return {
      kind: "retryTransport",
      delayMs,
      freshConnection: false,
      curve: "terminal-less-empty",
    }
  }

  // Mid-stream: multi-second base + floor so a thinking provider is not
  // hammered (session 113921b7 "after 0.0s" failure mode).
  const ideal = Math.min(
    TERMINALLESS_RETRY_MAX_DELAY_MS,
    TERMINALLESS_MIDSTREAM_RETRY_BASE_DELAY_MS * 2 ** exp,
  )
  const floor = Math.floor(TERMINALLESS_MIDSTREAM_RETRY_BASE_DELAY_MS / 2)
  const delayMs = floor + Math.floor(jitter * Math.max(0, ideal - floor))
  return {
    kind: "retryTransport",
    delayMs,
    freshConnection: false,
    curve: "terminal-less-midstream",
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

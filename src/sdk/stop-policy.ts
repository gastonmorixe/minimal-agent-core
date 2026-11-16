/**
 * The stop decision for one attempt of a round in `AgentCore.run`.
 *
 * {@link decideNext} is a pure function over the loop state and what the
 * attempt produced. It is the v2 stop table (spec section 2.1). The rows are
 * checked in a fixed order and the first match decides. The loop runs the
 * effect (notices, continuation messages, tool calls, retry waits); this
 * module does no I/O.
 *
 * | #  | Condition                                        | Decision            |
 * |----|--------------------------------------------------|---------------------|
 * | 1  | Signal aborted                                   | stop `aborted`      |
 * | 2  | `tool_use` blocks, normal close                  | run tools           |
 * | 3  | `max_tokens`, streak 1 to 5                      | continue            |
 * | 4  | `max_tokens`, streak above 5                     | stop `truncated`    |
 * | 5  | Terminal-less close after text, streak 1         | continue            |
 * | 6  | Same, streak above 1                             | stop `truncated`    |
 * | 7  | Terminal-less close after a completed tool call  | run tools (salvage) |
 * | 8  | Terminal-less close, no completed tool call      | retry               |
 * | 9  | `transient` error                                | retry               |
 * | 10 | `recoverable` error                              | recover, then retry |
 * | 11 | `permanent` error                                | stop `waiting`      |
 * | 12 | Tool batch gate refuses                          | stop `failed`       |
 * | 13 | No `tool_use` (`end_turn`, `stop_sequence`, ...) | stop `completed`    |
 *
 * No row counts rounds or retries: there is no round cap and no retry cap.
 * The two streak guards (rows 4 and 6, decision D20) end a turn, not the
 * run. They stop a model that loops on degenerate output, which retrying
 * cannot fix.
 *
 * Rows 3 and 5 have one loop override (follow-up 15a, `sdk/continuation.ts`):
 * when the continuation has no text (the `continue.*` text is "", or the
 * response was empty and the `assistant.placeholder` text is ""), the loop
 * sends no new body. It ends the turn as `truncated` (like rows 4 and 6),
 * emits no `*_continuing` TurnNotice, and records the warning
 * `continuation.no_text`. In bare core (no text provider) this is always
 * the case.
 *
 * @module sdk/stop-policy
 */

import {
  type ClassifiedError,
  type RecoveryAction,
  TERMINAL_LESS_TAG,
} from "../llm/transport/retry-policy.ts"

/** Row 4 guard (D20): more `max_tokens` continuations in a row than this end the turn. */
export const MAX_TOKENS_CONTINUATION_CAP = 5
/** Row 6 guard (D20): more terminal-less continuations after text than this end the turn. */
export const MAX_INTERRUPTED_TURN_CONTINUATIONS = 1

/** How a turn ended. There is no `capped` outcome: there is no round cap. */
export type TurnOutcome = "completed" | "truncated" | "failed" | "aborted" | "waiting"

/** The two D20 streaks the table reads. */
export interface Streaks {
  /** Consecutive `max_tokens` responses with no tool call. */
  maxTokens: number
  /** Consecutive terminal-less closes after text. */
  interrupted: number
}

/** Loop state at the decision point. */
export interface LoopState {
  aborted: boolean
  streaks: Streaks
  /** Recovery actions already run in this round. */
  recoveriesTried: readonly RecoveryAction[]
}

/** The facts of a model response the table reads. */
export interface ResponseFacts {
  stopReason: string | null
  /** Number of `tool_use` blocks in the response. */
  toolUseCount: number
  /** The stream closed with no terminal event (the bridge salvaged it). */
  terminalLess: boolean
}

/** What one attempt produced. */
export type AttemptResult =
  | { kind: "response"; response: ResponseFacts }
  | { kind: "error"; error: ClassifiedError }
  | { kind: "tool_batch_refused"; reason: string }

/** The decision, tagged with the table row that made it. */
export type StopDecision = (
  | { row: 1; kind: "stop"; outcome: "aborted" }
  | { row: 2; kind: "run_tools"; salvaged: false }
  | { row: 3; kind: "continue"; reason: "max_tokens"; attempt: number }
  | { row: 4; kind: "stop"; outcome: "truncated"; reason: "max_tokens" }
  | { row: 5; kind: "continue"; reason: "interrupted_text"; attempt: number }
  | { row: 6; kind: "stop"; outcome: "truncated"; reason: "interrupted_text" }
  | { row: 7; kind: "run_tools"; salvaged: true }
  | { row: 8 | 9; kind: "retry"; error: ClassifiedError }
  | { row: 10; kind: "recover"; action: RecoveryAction; error: ClassifiedError }
  | { row: 11; kind: "stop"; outcome: "waiting"; error: ClassifiedError }
  | { row: 12; kind: "stop"; outcome: "failed"; reason: string }
  | { row: 13; kind: "stop"; outcome: "completed" }
) & {
  /** Streak values after this decision. */
  streaks: Streaks
}

/**
 * Decide what the loop does next. Pure: same input, same decision.
 *
 * A recovery runs once per round. A `recoverable` error whose action already
 * ran in this round is treated as permanent ("invalid after recovery"). The
 * quota wait is the exception: a later reset time is a new wait, not a
 * failed recovery.
 */
export function decideNext(state: LoopState, result: AttemptResult): StopDecision {
  const { streaks } = state
  if (state.aborted) return { row: 1, kind: "stop", outcome: "aborted", streaks }

  switch (result.kind) {
    case "response":
      return decideResponse(streaks, result.response)
    case "error": {
      const error = result.error
      switch (error.errorClass) {
        case "transient":
          return { row: error.cause === TERMINAL_LESS_TAG ? 8 : 9, kind: "retry", error, streaks }
        case "recoverable": {
          const action = error.recovery
          if (
            action !== undefined &&
            (action === "wait_for_quota" || !state.recoveriesTried.includes(action))
          ) {
            return { row: 10, kind: "recover", action, error, streaks }
          }
          return { row: 11, kind: "stop", outcome: "waiting", error, streaks }
        }
        case "permanent":
          return { row: 11, kind: "stop", outcome: "waiting", error, streaks }
        default: {
          const _exhaustive: never = error.errorClass
          throw new Error(`unhandled error class: ${String(_exhaustive)}`)
        }
      }
    }
    case "tool_batch_refused":
      return { row: 12, kind: "stop", outcome: "failed", reason: result.reason, streaks }
    default: {
      const _exhaustive: never = result
      throw new Error(`unhandled attempt result: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/** Rows 2 to 7 and 13: a response arrived. */
function decideResponse(streaks: Streaks, r: ResponseFacts): StopDecision {
  if (r.toolUseCount > 0 && !r.terminalLess) {
    return { row: 2, kind: "run_tools", salvaged: false, streaks: { ...streaks, interrupted: 0 } }
  }
  if (r.stopReason === "max_tokens" && r.toolUseCount === 0) {
    const maxTokens = streaks.maxTokens + 1
    const next = { maxTokens, interrupted: 0 }
    if (maxTokens <= MAX_TOKENS_CONTINUATION_CAP) {
      return { row: 3, kind: "continue", reason: "max_tokens", attempt: maxTokens, streaks: next }
    }
    return { row: 4, kind: "stop", outcome: "truncated", reason: "max_tokens", streaks: next }
  }
  if (r.terminalLess && r.toolUseCount === 0) {
    const interrupted = streaks.interrupted + 1
    const next = { ...streaks, interrupted }
    if (interrupted <= MAX_INTERRUPTED_TURN_CONTINUATIONS) {
      const attempt = interrupted
      return { row: 5, kind: "continue", reason: "interrupted_text", attempt, streaks: next }
    }
    return { row: 6, kind: "stop", outcome: "truncated", reason: "interrupted_text", streaks: next }
  }
  if (r.terminalLess) {
    return { row: 7, kind: "run_tools", salvaged: true, streaks: { ...streaks, interrupted: 0 } }
  }
  // Row 13. Other stop reasons with no tool call (refusal, pause_turn, none)
  // settle the same way; the loop already surfaced any stop notice.
  return { row: 13, kind: "stop", outcome: "completed", streaks: { maxTokens: 0, interrupted: 0 } }
}

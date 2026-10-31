/**
 * The retry and recovery steps of `AgentCore.run` (stop-table rows 8 to 10).
 *
 * `decideNext` picks the row; these functions run its effect:
 * - {@link recover} runs one recovery action for a `recoverable` error.
 * - {@link waitToRetry} waits before the next attempt and emits one `status`
 *   event for the wait (`waitBeforeRetry` adds the one diagnostic).
 *
 * Neither counts toward a limit. The attempt number only grows the backoff.
 *
 * @module sdk/run-recovery
 */

import type { Diagnostics } from "../diagnostics/hub.ts"
import { noteRecoveryFailed, waitBeforeRetry } from "../llm/transport/retry.ts"
import {
  type ClassifiedError,
  type RecoveryAction,
  type RetryPolicyOptions,
  retryDelayMs,
  SYSTEM_CLOCK,
} from "../llm/transport/retry-policy.ts"

/** The `status` event payload for one wait (the core adds `type: "status"`). */
export interface RetryStatus {
  phase: "retrying" | "waiting_for_quota"
  attempt: number
  nextDelayMs: number
  resetAt?: number
  cause: string
}

/** What the steps need from the core. */
export interface RecoveryHost {
  emitStatus(status: RetryStatus): void
  compact(opts: { reason: "exceeded" }): Promise<unknown>
  policy: RetryPolicyOptions
  /** The core's diagnostics handle (S20). */
  diagnostics: Diagnostics
}

/**
 * Stop-table row 10: run one recovery action before the retry. Returns
 * false when the action itself failed (the loop then pauses on the error).
 */
export async function recover(
  host: RecoveryHost,
  action: RecoveryAction,
  error: ClassifiedError,
): Promise<boolean> {
  switch (action) {
    case "refresh_credential":
      // The next attempt resolves the credential again from the store and
      // runs the transport's refresh layer, which is the refresh.
      return true
    case "compact":
      try {
        await host.compact({ reason: "exceeded" })
        return true
      } catch (err) {
        noteRecoveryFailed(host.diagnostics, action, error.cause, err)
        return false
      }
    case "wait_for_quota":
      // The wait itself is the recovery (see waitToRetry).
      return true
    default: {
      const _exhaustive: never = action
      throw new Error(`unhandled recovery: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Wait before the next attempt and emit one `status` event for it. A quota
 * error with a future reset waits until the reset (`waiting_for_quota`).
 * Everything else waits the backoff (`retrying`); `Retry-After` wins.
 * `attempt` is the 1-based attempt that just failed. Rejects when `signal`
 * aborts during the wait.
 */
export async function waitToRetry(
  host: RecoveryHost,
  error: ClassifiedError,
  attempt: number,
  elapsedMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const now = (host.policy.clock ?? SYSTEM_CLOCK).now()
  const resetAt = error.recovery === "wait_for_quota" ? error.resetAt : undefined
  const quota = resetAt !== undefined && resetAt > now
  const { delayMs, curve } = quota
    ? { delayMs: resetAt - now, curve: "quota" as const }
    : retryDelayMs(error, attempt, host.policy)
  host.emitStatus({
    phase: quota ? "waiting_for_quota" : "retrying",
    attempt: attempt + 1,
    nextDelayMs: delayMs,
    ...(quota ? { resetAt } : {}),
    cause: error.cause,
  })
  await waitBeforeRetry({
    error,
    nextAttempt: attempt + 1,
    delayMs,
    curve,
    elapsedMs,
    ...(signal ? { signal } : {}),
    policy: host.policy,
    diagnostics: host.diagnostics,
  })
}

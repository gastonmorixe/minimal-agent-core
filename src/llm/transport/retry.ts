/**
 * Provider-neutral retry coordinator.
 *
 * Two parts:
 *
 * - The wait helpers ({@link waitBeforeRetry}, {@link noteRetryRecovered},
 *   {@link retryStallMarker}) that the agent loop (`AgentCore.run`) calls on
 *   each retry. Each wait emits one `api.retry` diagnostic, shows the status
 *   line, and sleeps on an injectable clock.
 * - {@link withRetry}, which wraps one attempt factory for side calls that
 *   do not run in the agent loop (the plugin `llm.complete` capability). It
 *   retries `transient` errors with the same policy and throws every other
 *   error to its caller.
 *
 * Delays come from `retry-policy.ts`, so both pick the same wait for the
 * same error.
 *
 * # Harness principle (intentional deviation from generic Retry+Backoff)
 *
 * There is deliberately NO `maxAttempts` and NO total deadline for transient
 * failures. The agent harness must outlive transient outages: it retries
 * every transient error forever, with backoff capped at 60 s (a `Retry-After`
 * wins), and only stops when the caller's `signal` aborts (Esc / Ctrl-C) or
 * the error is not transient. This is "retry forever, politely": capped
 * backoff + jitter + user-abortable, not a blind `while(true)` hammer.
 *
 * # Terminal-less stream close (progress-aware; still never give up)
 *
 * After completed tool calls, never re-POST the same body (side effects /
 * transcript divergence). The classifier marks that error `permanent`
 * and the bridge salvages it. Pre-effect closes (empty or
 * mid-reasoning, no completed tools) retry FOREVER with polite capped
 * backoff (multi-second floor when reasoning was seen so we do not thrash
 * a thinking model — session 37b74c04). That matches the harness principle:
 * multi-day agentic runs must not stop for a human re-prompt on network EOF.
 * Only the caller's AbortSignal (Esc) ends the loop.
 *
 * Idle aborts during open thinking are classified as `stream_idle` by the
 * watchdog (thinking-aware idle budget), which is also forever-retried on
 * the fast curve. (The bridge usually salvages completed tools / partial
 * text without throwing; this path is defense-in-depth.)
 *
 * # Pre-stream stalls (MA-882492)
 *
 * When `stream_idle` carries `stallPhase: "pre-stream"` (upload / TTFB /
 * headers, no body yet), retry uses a multi-second floor (`pre-stream` curve)
 * so multi-MB POSTs are not re-fired every ~100ms. Mid-stream idle stays on
 * the fast curve. Phase is read from the thrown error, not diag alone.
 *
 * @module llm/transport/retry
 */

import { NOOP_STATUS_PORT } from "../../bus/status-port.ts"
import { type Diagnostics, processDiagnostics } from "../../diagnostics/hub.ts"

import {
  type ClassifiedError,
  classifyError,
  type RetryCurve,
  type RetryPolicyOptions,
  retryDelayMs,
  SYSTEM_CLOCK,
  TERMINAL_LESS_TAG,
} from "./retry-policy.ts"
import type { StreamedResponse } from "./types.ts"

/** Every this many retries, the `api.retry` diagnostic says the run is still stuck. */
const RETRY_SUSTAINED_WARN_EVERY = 12

export interface RetryOptions extends RetryPolicyOptions {
  /** Caller cancellation. Aborts the backoff sleep and stops the loop. */
  signal?: AbortSignal
  /** Where the retry diagnostics go (S20). Default: the process bus. */
  diagnostics?: Diagnostics
}

/** Format a ms duration as `12s` / `1m 47s` / `2h 13m` / `1d 4h`. */
function formatElapsedLong(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** One wait before the next attempt. */
export interface RetryWait {
  /** The error that failed the last attempt. */
  error: ClassifiedError
  /** Number of the attempt that starts after the wait (2 for the first retry). */
  nextAttempt: number
  delayMs: number
  curve: RetryCurve | "quota"
  /** Time since the first attempt started, in ms. */
  elapsedMs: number
  signal?: AbortSignal
  /** Tunables (the clock is the one used here). */
  policy?: RetryPolicyOptions
  /** Where the `api.retry` diagnostic goes (S20). */
  diagnostics: Diagnostics
}

/**
 * Wait before the next attempt: emit one `api.retry` diagnostic, show the
 * status line, and sleep on the policy clock. Rejects with the abort reason
 * when `signal` aborts during the sleep.
 */
export async function waitBeforeRetry(w: RetryWait): Promise<void> {
  const { error: c, nextAttempt, delayMs, curve, elapsedMs } = w
  const retries = nextAttempt - 1
  const sustained = retries > 1 && (retries - 1) % RETRY_SUSTAINED_WARN_EVERY === 0
  const what = curve === "quota" ? "waiting for quota reset" : `${curve} retry`
  w.diagnostics.warn(
    "api.retry",
    `${c.cause}: ${what}, attempt ${nextAttempt} after ${(delayMs / 1000).toFixed(1)}s, ${formatElapsedLong(elapsedMs)} elapsed${sustained ? ", still retrying" : ""}`,
    {
      "error-type": c.cause,
      "error-class": c.errorClass,
      attempt: nextAttempt,
      "delay-ms": delayMs,
      "elapsed-ms": elapsedMs,
      curve,
      ...(c.stallPhase ? { phase: c.stallPhase } : {}),
      ...(c.resetAt !== undefined ? { "reset-at": c.resetAt } : {}),
      ...(c.cause === TERMINAL_LESS_TAG
        ? {
            "fresh-connection": false,
            "completed-tool-calls": c.progress?.completedToolCalls ?? 0,
            "saw-text": c.progress?.sawText ?? false,
            "saw-reasoning": c.progress?.sawReasoning ?? false,
          }
        : {}),
      ...(sustained ? { sustained: true } : {}),
    },
  )
  const status = (w.policy?.statusPort ?? NOOP_STATUS_PORT).open({
    phase: curve === "quota" ? "waiting_for_quota" : "retrying",
    attempt: nextAttempt,
    nextDelayMs: delayMs,
    cause: c.cause,
    ...(curve === "quota" && c.resetAt !== undefined ? { resetAt: c.resetAt } : {}),
  })
  try {
    await (w.policy?.clock ?? SYSTEM_CLOCK).sleep(delayMs, w.signal)
  } finally {
    status.clear()
  }
}

/**
 * Note that an attempt succeeded after retries. The notices clear the TUI
 * stall and retry banners (same sources as the warnings).
 */
export function noteRetryRecovered(
  diagnostics: Diagnostics,
  retries: number,
  elapsedMs: number,
  lastCause: string,
): void {
  diagnostics.notice(
    "api.retry-success",
    `recovered after ${retries} retr${retries === 1 ? "y" : "ies"} (${formatElapsedLong(elapsedMs)} total) — last error ${lastCause}`,
    { attempt: retries + 1, retries, "elapsed-ms": elapsedMs, "last-error": lastCause },
  )
  diagnostics.notice("api.stream-stalled", "stream recovered after retry", { recovery: "true" })
  diagnostics.notice("api.retry", "retry recovered", { recovery: "true" })
}

/** Note that a recovery action failed, so the loop pauses on the original error. */
export function noteRecoveryFailed(
  diagnostics: Diagnostics,
  action: string,
  cause: string,
  err: unknown,
): void {
  diagnostics.warn("api.recovery-failed", `${action} failed after ${cause}: ${String(err)}`, {
    action,
    "error-type": cause,
  })
}

/**
 * Visible boundary for the text channel when an attempt already streamed
 * text, so attempt N's partial output and attempt N+1's do not glue together.
 */
export function retryStallMarker(nextAttempt: number): string {
  return `\n↳ stream stalled — retrying (attempt ${nextAttempt})…\n`
}

/**
 * Retry `makeAttempt` forever on `transient` errors. Every other error
 * (recoverable, permanent, unclassified, abort) is thrown to the caller.
 * Yields the attempt's text deltas (plus a stall marker on retry after a
 * yield) and returns the successful attempt's `StreamedResponse`.
 *
 * @param makeAttempt - Fresh attempt factory. Called once per attempt; each
 *   call must start a brand-new request (the watchdog + auth-refresh layers
 *   live inside it, so a fresh attempt re-runs them with current auth).
 * @yields Text deltas, interleaved with `↳ stream stalled` markers on retry.
 * @returns The first successful attempt's `StreamedResponse`.
 */
export async function* withRetry(
  makeAttempt: () => AsyncGenerator<string, StreamedResponse, undefined>,
  opts: RetryOptions = {},
): AsyncGenerator<string, StreamedResponse, undefined> {
  let hasYielded = false
  const diagnostics = opts.diagnostics ?? processDiagnostics()
  const clock = opts.clock ?? SYSTEM_CLOCK
  const startedAt = clock.now()
  let lastCause = "unknown"

  for (let attempt = 1; ; attempt++) {
    try {
      const gen = makeAttempt()
      // Manual drain so we can flip `hasYielded` (the retry-marker gate)
      // while preserving yield order AND the generator's return value.
      let result: IteratorResult<string, StreamedResponse>
      // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
      while (!(result = await gen.next()).done) {
        hasYielded = true
        yield result.value
      }
      if (attempt > 1) {
        noteRetryRecovered(diagnostics, attempt - 1, clock.now() - startedAt, lastCause)
      }
      return result.value
    } catch (err) {
      const c = classifyError(err)
      if (c?.errorClass !== "transient") {
        // Post-tool terminal-less close: never send the same body again.
        if (c?.cause === TERMINAL_LESS_TAG) {
          diagnostics.warn(
            "api.retry-terminal-less-stop",
            `stream_closed_without_terminal: continueTurn — terminalLessClose (completedToolCalls=${c.progress?.completedToolCalls ?? 0})`,
            {
              "error-type": c.cause,
              decision: "continueTurn",
              "completed-tool-calls": c.progress?.completedToolCalls ?? 0,
              "saw-text": c.progress?.sawText ?? false,
              "saw-reasoning": c.progress?.sawReasoning ?? false,
              "elapsed-ms": clock.now() - startedAt,
            },
          )
        }
        throw err
      }
      lastCause = c.cause
      const { delayMs, curve } = retryDelayMs(c, attempt, opts)
      if (hasYielded) yield retryStallMarker(attempt + 1)
      await waitBeforeRetry({
        error: c,
        nextAttempt: attempt + 1,
        delayMs,
        curve,
        elapsedMs: clock.now() - startedAt,
        ...(opts.signal ? { signal: opts.signal } : {}),
        policy: opts,
        diagnostics,
      })
      // Next loop iteration: a fresh attempt with the (possibly refreshed)
      // auth/token from the prior attempt's auth-refresh layer.
    }
  }
}

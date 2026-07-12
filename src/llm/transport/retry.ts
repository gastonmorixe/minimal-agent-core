/**
 * Provider-neutral retry coordinator.
 *
 * Wraps an "attempt" (a generator that yields text deltas and returns a
 * `StreamedResponse`) and retries it on tagged, retryable failures with
 * capped, jittered exponential backoff. It is a faithful port of the
 * `sendMessage` retry loop in `client.ts` (same `streamErrorType` sets,
 * same fast/slow curves, same sustained-retry heartbeat, same visible
 * stall marker, same status-bus updates, same `api.retry*` diag events),
 * operating on a generic attempt factory instead of `sendMessageOnce`.
 *
 * # Harness principle (intentional deviation from generic Retry+Backoff)
 *
 * There is deliberately NO `maxAttempts` and NO total deadline for ordinary
 * tagged transport failures. The agent harness must outlive transient
 * outages: it retries every tagged error forever, with backoff capped at
 * 5 min, and only stops when the caller's `signal` aborts (Esc / Ctrl-C) or
 * the error is untagged (a real bug, not "the network is slow today"). This
 * is "retry forever, politely" : capped backoff + jitter + user-abortable +
 * sustained-warning, not a blind `while(true)` hammer.
 *
 * # Terminal-less stream close (progress-aware exception)
 *
 * `stream_closed_without_terminal` is NOT on the forever/slow curve. A
 * Grok/OpenAI Responses 200 SSE can close after complete tool calls without
 * `response.completed`; replaying that request body forever is the incident
 * this policy prevents. Recovery uses {@link decideTerminalLessRecovery}:
 * at most one short pre-effect retry; never replay after completed tools.
 * (The bridge usually salvages completed tools and returns without throwing;
 * this path is defense-in-depth if a throw still carries progress.)
 *
 * @module llm/transport/retry
 */

import { abortableSleep } from "@minimal-agent/plugin-api/utils/retry"

import { diag } from "../../bus/diagnostic-bus.ts"
import { GLOBAL_STATUS_BUS } from "../../bus/status.ts"
import {
  TRANSIENT_NETWORK_STREAM_ERROR_TYPE,
  tagTransientNetworkError,
} from "../../network/index.ts"

import { decideTerminalLessRecovery, readAttemptProgress } from "./attempt-progress.ts"
import type { StreamedResponse } from "./types.ts"

/**
 * Stream-error types that retry on the FAST curve. Mirrors
 * `client.ts`'s `RETRYABLE_STREAM_ERROR_TYPES`. Each is retried forever;
 * membership only selects the backoff curve.
 */
const RETRYABLE_STREAM_ERROR_TYPES: ReadonlySet<string> = new Set([
  "overloaded_error",
  "api_error",
  "stream_idle",
  // NOTE: stream_truncated is intentionally NOT retried. When the server
  // closes the SSE stream without a terminator (message_stop / [DONE]),
  // the cause is usually an intentional model refusal or content filter
  // decision, not a transient network failure. Retrying the same prompt
  // produces the same refusal, freezing the agent in an infinite retry
  // loop (session 81adb696, 2026-06-19). The error must propagate so the
  // agent surfaces partial output and moves on.
  "attempt_too_long",
  // Connection-level transient failures thrown out of the transport before
  // any response exists (connect timeout, reset socket, DNS blip, GOAWAY).
  // Tagged `network_error` by the transient-network classifier in the catch
  // below. Mirrors client.ts. See network/transient-error.ts.
  TRANSIENT_NETWORK_STREAM_ERROR_TYPE,
  // Pre-effect terminal-less closes use a dedicated bounded policy below,
  // but remain "known" to the tag classifier so we enter the catch path.
  // They are NOT forever-retried and NOT on the slow rate-limit curve.
  "stream_closed_without_terminal",
])

/**
 * Hard-error types that retry on the SLOW curve. Mirrors `client.ts` for
 * rate limits only.
 *
 * `rate_limit_error` is here (not in the fast set) so a 429 waits the
 * limit window out on the 30s→5min curve instead of hammering a closed
 * window sub-second. It retries forever because the window can clear on
 * its own. Keep in sync with `client.ts`'s `SLOW_RETRY_TYPES`.
 *
 * NOTE: `stream_closed_without_terminal` used to live here and caused
 * unlimited 30s-curve replay of side-effecting Grok request bodies after
 * tool progress (session 523dba62). It is handled by progress-aware
 * recovery instead.
 */
const SLOW_RETRY_TYPES: ReadonlySet<string> = new Set(["rate_limit_error"])

const RETRY_FAST_BASE_DELAY_MS = 200
const RETRY_SLOW_BASE_DELAY_MS = 30_000
const RETRY_MAX_DELAY_MS = 5 * 60_000
const RETRY_SUSTAINED_WARN_EVERY = 12

export interface RetryOptions {
  /** Caller cancellation. Aborts the backoff sleep and stops the loop. */
  signal?: AbortSignal
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

/** True iff the thrown error is a tagged, retryable stream error. */
function retryableStreamErrorType(err: unknown): string | undefined {
  // An explicit `retryable: false` verdict from the provider wins over
  // tag-based classification. Billing exhaustion (insufficient_quota) and
  // other terminal failures set this so they propagate instead of feeding
  // the forever-retry loop, even if a category→tag remap would otherwise
  // land them in a retryable bucket.
  if ((err as { retryable?: boolean } | null)?.retryable === false) return undefined
  const t = (err as { streamErrorType?: string } | null)?.streamErrorType
  if (t !== undefined && (RETRYABLE_STREAM_ERROR_TYPES.has(t) || SLOW_RETRY_TYPES.has(t))) {
    return t
  }
  return undefined
}

/**
 * Retry `makeAttempt` forever on tagged retryable errors (except
 * progress-aware terminal-less closes). Yields the attempt's text deltas
 * (plus a visible stall marker on retry-after-yield) and returns the
 * successful attempt's `StreamedResponse`.
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
  const startedAt = Date.now()
  let lastStreamErrType: string | undefined
  /** Bounded counter for pre-effect terminal-less transport retries only. */
  let terminalLessRetries = 0

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
        const totalMs = Date.now() - startedAt
        diag.warn(
          "api.retry-success",
          `recovered after ${attempt - 1} retr${attempt - 1 === 1 ? "y" : "ies"} (${formatElapsedLong(totalMs)} total) — last error ${lastStreamErrType ?? "unknown"}`,
          {
            attempt,
            retries: attempt - 1,
            "elapsed-ms": totalMs,
            "last-error": lastStreamErrType ?? "unknown",
          },
        )
      }
      return result.value
    } catch (err) {
      // Tag connection-level transient failures (connect timeout, reset
      // socket, DNS blip, GOAWAY) the transport threw with no
      // `streamErrorType`. The classifier excludes user aborts, so a real
      // Ctrl-C still propagates. No-op for already-tagged errors.
      const streamErrType = retryableStreamErrorType(tagTransientNetworkError(err))
      const elapsedMs = Date.now() - startedAt
      // Untagged / non-retryable errors (programmer bugs, auth-final,
      // cancellation) propagate. Only tagged transient/hard errors retry.
      if (streamErrType === undefined) throw err
      lastStreamErrType = streamErrType

      // ------------------------------------------------------------------
      // Terminal-less close: progress-aware, bounded. Never forever-replay.
      // ------------------------------------------------------------------
      if (streamErrType === "stream_closed_without_terminal") {
        const progress = readAttemptProgress(err)
        const decision = decideTerminalLessRecovery({
          progress,
          priorTerminalLessRetries: terminalLessRetries,
        })

        if (decision.kind === "continueTurn" || decision.kind === "failTurn") {
          // Post-tool or budget exhausted: do NOT call makeAttempt again.
          diag.warn(
            "api.retry-terminal-less-stop",
            `stream_closed_without_terminal: ${decision.kind} — ${decision.kind === "failTurn" ? decision.reason : decision.reason} (completedToolCalls=${progress?.completedToolCalls ?? 0})`,
            {
              "error-type": streamErrType,
              decision: decision.kind,
              "completed-tool-calls": progress?.completedToolCalls ?? 0,
              "saw-text": progress?.sawText ?? false,
              "saw-reasoning": progress?.sawReasoning ?? false,
              "elapsed-ms": elapsedMs,
            },
          )
          throw err
        }

        // decision.kind === "retryTransport"
        terminalLessRetries++
        const delayMs = decision.delayMs
        const nextAttempt = attempt + 1
        diag.warn(
          "api.retry",
          `${streamErrType}: bounded pre-effect retry attempt ${nextAttempt} after ${(delayMs / 1000).toFixed(1)}s — ${formatElapsedLong(elapsedMs)} elapsed so far`,
          {
            "error-type": streamErrType,
            attempt: nextAttempt,
            "delay-ms": delayMs,
            "elapsed-ms": elapsedMs,
            curve: "terminal-less-bounded",
            "fresh-connection": decision.freshConnection,
            "completed-tool-calls": progress?.completedToolCalls ?? 0,
          },
        )
        if (hasYielded) {
          yield `\n↳ stream stalled — retrying (attempt ${nextAttempt})…\n`
        }
        const retryStatus = GLOBAL_STATUS_BUS.create(
          `Retrying after ${streamErrType} (attempt ${nextAttempt}) — sleeping ${(delayMs / 1000).toFixed(1)}s…`,
          { notificationId: "network.retry", category: "network" },
        )
        try {
          await abortableSleep(delayMs, opts.signal)
        } finally {
          retryStatus.clear()
        }
        continue
      }

      const slow = SLOW_RETRY_TYPES.has(streamErrType)
      const base = slow ? RETRY_SLOW_BASE_DELAY_MS : RETRY_FAST_BASE_DELAY_MS
      const cappedExp = Math.min(attempt - 1, 16)
      const ideal = Math.min(RETRY_MAX_DELAY_MS, base * 2 ** cappedExp)
      const delayMs = Math.floor(Math.random() * ideal)
      const nextAttempt = attempt + 1

      diag.warn(
        "api.retry",
        `${streamErrType}: retrying attempt ${nextAttempt} after ${(delayMs / 1000).toFixed(1)}s — ${formatElapsedLong(elapsedMs)} elapsed so far`,
        {
          "error-type": streamErrType,
          attempt: nextAttempt,
          "delay-ms": delayMs,
          "elapsed-ms": elapsedMs,
          curve: slow ? "slow" : "fast",
        },
      )

      if (attempt > 1 && (attempt - 1) % RETRY_SUSTAINED_WARN_EVERY === 0) {
        diag.warn(
          "api.retry-sustained",
          `still retrying — ${attempt - 1} attempts, stuck for ${formatElapsedLong(elapsedMs)}, last error ${streamErrType}`,
          {
            attempt,
            retries: attempt - 1,
            "elapsed-ms": elapsedMs,
            "last-error": streamErrType,
            curve: slow ? "slow" : "fast",
          },
        )
      }

      // Paint a visible boundary in scrollback if we already streamed text,
      // so attempt N's partial output and attempt N+1's don't glue together.
      if (hasYielded) {
        yield `\n↳ stream stalled — retrying (attempt ${nextAttempt})…\n`
      }

      const retryStatus = GLOBAL_STATUS_BUS.create(
        `Retrying after ${streamErrType} (attempt ${nextAttempt}) — sleeping ${(delayMs / 1000).toFixed(1)}s…`,
        { notificationId: "network.retry", category: "network" },
      )
      try {
        await abortableSleep(delayMs, opts.signal)
      } finally {
        retryStatus.clear()
      }
      // Next loop iteration: a fresh attempt with the (possibly refreshed)
      // auth/token from the prior attempt's auth-refresh layer.
    }
  }
}

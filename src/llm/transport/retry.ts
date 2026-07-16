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
 * # Terminal-less stream close (progress-aware; still never give up)
 *
 * After completed tool calls, never re-POST the same body (side effects /
 * transcript divergence) — {@link decideTerminalLessRecovery} returns
 * `continueTurn` and the bridge salvages. Pre-effect closes (empty or
 * mid-reasoning, no completed tools) retry FOREVER with polite capped
 * backoff (multi-second floor when reasoning was seen so we do not thrash
 * a thinking model — session 113921b7). That matches the harness principle:
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
  // Terminal-less closes use a dedicated progress-aware policy below, but
  // remain "known" to the tag classifier so we enter the catch path. Pre-
  // effect closes retry forever (never-give-up); post-tool closes do not
  // re-POST (continueTurn / salvage). Not on the slow rate-limit curve.
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
/** Polite floor for pre-stream stalls (upload/TTFB) so multi-MB bodies are not re-POSTed every ~100ms (MA-882492). */
const RETRY_PRE_STREAM_BASE_DELAY_MS = 2_000
const RETRY_MAX_DELAY_MS = 5 * 60_000
const RETRY_SUSTAINED_WARN_EVERY = 12

export interface RetryOptions {
  /** Caller cancellation. Aborts the backoff sleep and stops the loop. */
  signal?: AbortSignal
}

/** Structured stall phase from {@link WatchdogError} (retry policy must read the error, not diag). */
function readStallPhase(err: unknown): "pre-stream" | "mid-stream" | undefined {
  const p = (err as { stallPhase?: string } | null)?.stallPhase
  if (p === "pre-stream" || p === "mid-stream") return p
  return undefined
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
          // Post-tool salvage (continueTurn): do NOT call makeAttempt again.
          // failTurn is not emitted by current terminal-less policy (never-give-up)
          // but remains handled if a future path returns it.
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
        const curve = decision.curve
        diag.warn(
          "api.retry",
          `${streamErrType}: ${curve} retry attempt ${nextAttempt} after ${(delayMs / 1000).toFixed(1)}s — ${formatElapsedLong(elapsedMs)} elapsed so far`,
          {
            "error-type": streamErrType,
            attempt: nextAttempt,
            "delay-ms": delayMs,
            "elapsed-ms": elapsedMs,
            curve,
            "fresh-connection": decision.freshConnection,
            "completed-tool-calls": progress?.completedToolCalls ?? 0,
            "saw-text": progress?.sawText ?? false,
            "saw-reasoning": progress?.sawReasoning ?? false,
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
      const stallPhase = readStallPhase(err)
      // Pre-stream (upload/TTFB) stalls use a multi-second floor so large
      // identical POSTs are not hammered on the fast 200ms curve (MA-882492).
      const preStream = stallPhase === "pre-stream" && streamErrType === "stream_idle"
      const base = slow
        ? RETRY_SLOW_BASE_DELAY_MS
        : preStream
          ? RETRY_PRE_STREAM_BASE_DELAY_MS
          : RETRY_FAST_BASE_DELAY_MS
      const cappedExp = Math.min(attempt - 1, 16)
      const ideal = Math.min(RETRY_MAX_DELAY_MS, base * 2 ** cappedExp)
      // Pre-stream: floor at base (2s) so jitter cannot collapse to sub-second thrash.
      const raw = Math.floor(Math.random() * ideal)
      const delayMs = preStream ? Math.max(RETRY_PRE_STREAM_BASE_DELAY_MS, raw) : raw
      const nextAttempt = attempt + 1
      const curve = slow ? "slow" : preStream ? "pre-stream" : "fast"

      diag.warn(
        "api.retry",
        `${streamErrType}: retrying attempt ${nextAttempt} after ${(delayMs / 1000).toFixed(1)}s — ${formatElapsedLong(elapsedMs)} elapsed so far`,
        {
          "error-type": streamErrType,
          attempt: nextAttempt,
          "delay-ms": delayMs,
          "elapsed-ms": elapsedMs,
          curve,
          ...(stallPhase ? { phase: stallPhase } : {}),
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
            curve,
            ...(stallPhase ? { phase: stallPhase } : {}),
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

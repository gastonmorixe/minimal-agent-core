/**
 * Provider-neutral stream watchdog middleware.
 *
 * Wraps a single canonical attempt's event stream and guards against the
 * two silent-hang shapes the legacy `client.ts` watchdog was built for
 * (root-caused 2026-05-25, see `client.stream-watchdog.test.ts`):
 *
 *   1. **idle** : the server stops emitting SSE events but neither closes
 *      the body nor sends `message_stop`. HTTP/2 PINGs keep the socket
 *      alive, so the iterator blocks forever. Fires `stream_idle` after
 *      `streamIdleTimeoutMs` of silence (or the longer thinking-idle
 *      budget while a reasoning block is open — see below).
 *   2. **hard timeout** : a single attempt runs past `attemptHardTimeoutMs`
 *      (slow trickle of irrelevant frames that never reaches idle). Fires
 *      `attempt_too_long`.
 *   3. **truncation** : the body closes cleanly but `message_stop` never
 *      arrived. Fires `stream_truncated`.
 *
 * # Thinking-aware idle (Grok / OpenAI Responses, session 113921b7)
 *
 * Reasoning models routinely pause 30s+ between summary deltas while still
 * computing. A flat 30s idle abort during an open thinking block is a
 * false positive: the watchdog cancels a healthy stream, the provider
 * adapter synthesizes `stream_closed_without_terminal`, and the old
 * terminal-less policy hard-failed after one near-zero retry. While a
 * thinking block is open we use {@link DEFAULT_THINKING_IDLE_TIMEOUT_MS}
 * (5 min) instead of the ordinary idle budget. The hard ceiling still
 * bounds pathological hangs.
 *
 * # Abort classification priority
 *
 * When the watchdog trips, the aborted HTTP body often drains as a clean
 * EOF. The Responses translator then yields a synthetic
 * `stream_error`/`stream_closed_without_terminal`. That event must NOT
 * replace the watchdog's `stream_idle` / `attempt_too_long` tag: once
 * `reason` is set we throw the watchdog error and stop yielding, so the
 * outer retry coordinator sees the real stall and uses the forever fast
 * curve instead of the terminal-less failTurn path.
 *
 * This is a faithful port of the inline watchdog in `sendMessageOnce`
 * (1s tick, idle-checked-before-hard, `unref`'d timer) but operating on
 * the canonical event stream instead of raw SSE. `client.ts` is NOT
 * touched : the legacy Anthropic path keeps its own copy.
 *
 * The thrown errors carry a `streamErrorType` string identical to the
 * legacy tags (`stream_idle` / `attempt_too_long` / `stream_truncated`)
 * so the retry coordinator (`./retry.ts`) classifies them the same way
 * `sendMessage`'s loop does.
 *
 * @module llm/transport/watchdog
 */

import type { CanonicalEvent } from "../canonical-events.ts"

/** Default idle timeout : matches `SendOptions.streamIdleTimeoutMs`. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000
/**
 * Idle budget while a thinking/reasoning block is open.
 *
 * Grok/OpenAI reasoning streams often go silent for well over 30s between
 * summary deltas while the model is still working. Aborting there is a
 * false positive (session 113921b7: ~33s elapsed, saw-reasoning=true,
 * completedToolCalls=0 → hard fail). Five minutes still catches a true
 * hang without mistaking long thinking for a dead socket; the hard
 * attempt ceiling remains the ultimate bound.
 */
export const DEFAULT_THINKING_IDLE_TIMEOUT_MS = 5 * 60_000
/** Default hard per-attempt ceiling : matches `SendOptions.attemptHardTimeoutMs`. */
export const DEFAULT_ATTEMPT_HARD_TIMEOUT_MS = 30 * 60_000

export type WatchdogAbortReason = "stream_idle" | "attempt_too_long" | "stream_truncated"

/** Tagged error thrown when the watchdog trips. Always retryable. */
export interface WatchdogError extends Error {
  streamErrorType: WatchdogAbortReason
}

function makeWatchdogError(reason: WatchdogAbortReason, message: string): WatchdogError {
  const err = new Error(message) as WatchdogError
  err.streamErrorType = reason
  return err
}

export interface WatchdogOptions {
  streamIdleTimeoutMs?: number
  /**
   * Idle budget while at least one thinking block is open. Defaults to
   * {@link DEFAULT_THINKING_IDLE_TIMEOUT_MS}. Must be ≥ the ordinary idle
   * timeout to be useful; smaller values are clamped up.
   */
  thinkingIdleTimeoutMs?: number
  attemptHardTimeoutMs?: number
  /** Upstream cancellation; linked into the attempt signal. */
  signal?: AbortSignal
  /**
   * Fired once when the watchdog trips, before the tagged error is thrown.
   * The transport wires this to the same `api.stream-stalled` diag the
   * legacy path emits.
   */
  onStall?: (info: { reason: WatchdogAbortReason; idleMs: number; elapsedMs: number }) => void
}

/**
 * Wrap a canonical attempt with the idle / hard-timeout / truncation
 * watchdog.
 *
 * `makeStream` receives the watchdog-owned `AbortSignal` : it MUST forward
 * it to the underlying transport (as `CanonicalRequest.signal`) so an
 * abort tears the HTTP stream down and unblocks the iterator. The signal
 * is also linked to `opts.signal` so an upstream cancel propagates.
 *
 * @yields the underlying canonical events, unchanged, until completion.
 */
export async function* withStreamWatchdog(
  makeStream: (signal: AbortSignal) => AsyncIterable<CanonicalEvent>,
  opts: WatchdogOptions = {},
): AsyncIterable<CanonicalEvent> {
  const idleTimeout = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const thinkingIdleTimeout = Math.max(
    idleTimeout,
    opts.thinkingIdleTimeoutMs ?? DEFAULT_THINKING_IDLE_TIMEOUT_MS,
  )
  const hardTimeout = opts.attemptHardTimeoutMs ?? DEFAULT_ATTEMPT_HARD_TIMEOUT_MS

  const ac = new AbortController()
  // Link upstream cancellation into the attempt signal.
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort()
    else opts.signal.addEventListener("abort", () => ac.abort(), { once: true })
  }

  const startedAt = Date.now()
  let lastEventAt = Date.now()
  let messageStopReceived = false
  let reason: WatchdogAbortReason | null = null
  /** Nested open thinking blocks (start without matching stop). */
  let openThinkingBlocks = 0

  const effectiveIdleTimeout = (): number =>
    openThinkingBlocks > 0 ? thinkingIdleTimeout : idleTimeout

  const timer = setInterval(() => {
    if (messageStopReceived || ac.signal.aborted || reason !== null) return
    const idleMs = Date.now() - lastEventAt
    const elapsedMs = Date.now() - startedAt
    if (idleMs >= effectiveIdleTimeout()) {
      reason = "stream_idle"
      ac.abort()
    } else if (elapsedMs >= hardTimeout) {
      reason = "attempt_too_long"
      ac.abort()
    }
  }, 1000)
  // Never block process exit on the watchdog timer.
  if (typeof timer.unref === "function") timer.unref()

  const fail = (code: WatchdogAbortReason): WatchdogError => {
    const idleMs = Date.now() - lastEventAt
    const elapsedMs = Date.now() - startedAt
    const message =
      code === "stream_idle"
        ? `no SSE event received for ${(idleMs / 1000).toFixed(1)}s — aborting (stalled mid-stream, no message_stop)`
        : code === "attempt_too_long"
          ? `attempt exceeded ${(elapsedMs / 1000).toFixed(0)}s — aborting`
          : `stream ended without message_stop after ${(elapsedMs / 1000).toFixed(1)}s (server truncated the SSE response)`
    opts.onStall?.({ reason: code, idleMs, elapsedMs })
    return makeWatchdogError(code, message)
  }

  try {
    for await (const ev of makeStream(ac.signal)) {
      // Watchdog already tripped: the aborted body may still drain and the
      // Responses translator may synthesize stream_closed_without_terminal.
      // Prefer the watchdog tag so retry uses stream_idle forever-fast, not
      // the terminal-less failTurn path (session 113921b7).
      if (reason !== null) throw fail(reason)

      lastEventAt = Date.now()
      if (ev.type === "thinking_start") openThinkingBlocks++
      else if (ev.type === "thinking_stop" && openThinkingBlocks > 0) openThinkingBlocks--
      if (ev.type === "message_stop") messageStopReceived = true
      yield ev
    }
  } catch (err) {
    // The watchdog tripped and aborted the transport (which may surface as
    // an AbortError rather than a clean close). Convert to the tagged
    // reason so the retry coordinator sees `stream_idle` / `attempt_too_long`.
    if (reason !== null) throw fail(reason)
    // Otherwise an upstream cancel or a genuine error : propagate as-is.
    throw err
  } finally {
    clearInterval(timer)
  }

  // Clean close without a terminator : either the watchdog tripped and the
  // body closed quietly, or the server truncated. Both retry.
  if (!messageStopReceived) {
    throw fail(reason ?? "stream_truncated")
  }
}

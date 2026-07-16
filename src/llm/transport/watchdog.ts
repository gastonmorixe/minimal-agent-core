/**
 * Provider-neutral stream watchdog middleware.
 *
 * Wraps a single canonical attempt's event stream and guards against silent
 * hangs across **two clocks** (MA-882492 / legacy `65ab8ca` pre-response guard):
 *
 *   0. **pre-stream** : from attempt start until the first **response body
 *      activity** (non-empty body byte via lifecycle hooks; CanonicalEvent
 *      yield is a fallback). Covers multi-MB upload + TTFB + wait-for-headers.
 *      Fires `stream_idle` with `stallPhase: "pre-stream"` after
 *      `responseHeadersTimeoutMs` (default **120s**). Mid-stream idle does
 *      **not** arm in this phase — that was the Emily/Sarah thrash bug.
 *   1. **mid-stream idle** : after first body activity, silence between
 *      body bytes / CanonicalEvents. Fires `stream_idle` with
 *      `stallPhase: "mid-stream"` after `streamIdleTimeoutMs` (or the longer
 *      thinking-idle budget while a reasoning block is open).
 *   2. **hard timeout** : a single attempt runs past `attemptHardTimeoutMs`.
 *      Fires `attempt_too_long`.
 *   3. **truncation** : the body closes cleanly but `message_stop` never
 *      arrived. Fires `stream_truncated`.
 *
 * # Thinking-aware idle (Grok / OpenAI Responses, session 113921b7)
 *
 * Reasoning models routinely pause 30s+ between summary deltas while still
 * computing. While a thinking block is open we use
 * {@link DEFAULT_THINKING_IDLE_TIMEOUT_MS} (5 min) instead of the ordinary
 * mid-stream idle budget.
 *
 * # Abort classification priority
 *
 * When the watchdog trips, the aborted HTTP body often drains as a clean
 * EOF. The Responses translator then yields a synthetic
 * `stream_error`/`stream_closed_without_terminal`. Once `reason` is set we
 * throw the watchdog error and stop yielding so retry sees the real stall.
 *
 * Thrown errors carry `streamErrorType` plus structured **`stallPhase`** so
 * the retry coordinator can choose polite pre-stream backoff vs mid-stream
 * fast curve (diag-only phase is not enough — MA-882492).
 *
 * @module llm/transport/watchdog
 */

import type { CanonicalEvent } from "../canonical-events.ts"

/** Default mid-stream idle timeout : matches `SendOptions.streamIdleTimeoutMs`. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000
/**
 * Idle budget while a thinking/reasoning block is open (mid-stream only).
 *
 * Grok/OpenAI reasoning streams often go silent for well over 30s between
 * summary deltas while the model is still working. Five minutes still catches
 * a true hang; the hard attempt ceiling remains the ultimate bound.
 */
export const DEFAULT_THINKING_IDLE_TIMEOUT_MS = 5 * 60_000
/** Default hard per-attempt ceiling : matches `SendOptions.attemptHardTimeoutMs`. */
export const DEFAULT_ATTEMPT_HARD_TIMEOUT_MS = 30 * 60_000
/**
 * Default pre-stream deadline (attempt start → first response body activity).
 * Matches legacy `65ab8ca` `responseHeadersTimeoutMs` / `SendOptions` docs.
 * Caller-overridable (tests lower it).
 */
export const DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS = 120_000

export type WatchdogAbortReason = "stream_idle" | "attempt_too_long" | "stream_truncated"

/**
 * Which attempt phase the stall was detected in.
 *
 * - `pre-stream` — no body activity yet (upload / TTFB / headers / first byte).
 * - `mid-stream` — body activity has started (bytes and/or CanonicalEvents);
 *   silence since last activity.
 *
 * Optional `stallSubPhase` refines pre-stream when lifecycle hooks know more.
 */
export type StallPhase = "pre-stream" | "mid-stream"

export type StallSubPhase = "pre-headers" | "headers-wait-body"

/** Tagged error thrown when the watchdog trips. Always retryable. */
export interface WatchdogError extends Error {
  streamErrorType: WatchdogAbortReason
  /**
   * Structured phase for retry policy + `api.retry` (required for pre-stream
   * polite backoff). Present on idle / hard / truncation trips from this
   * watchdog.
   */
  stallPhase?: StallPhase
  /** Optional refinement when headers vs first-body is known. */
  stallSubPhase?: StallSubPhase
}

function makeWatchdogError(
  reason: WatchdogAbortReason,
  message: string,
  phase: StallPhase,
  subPhase?: StallSubPhase,
): WatchdogError {
  const err = new Error(message) as WatchdogError
  err.streamErrorType = reason
  err.stallPhase = phase
  if (subPhase) err.stallSubPhase = subPhase
  return err
}

export interface StallInfo {
  reason: WatchdogAbortReason
  idleMs: number
  elapsedMs: number
  stallPhase: StallPhase
  stallSubPhase?: StallSubPhase
}

export interface WatchdogOptions {
  streamIdleTimeoutMs?: number
  /**
   * Idle budget while at least one thinking block is open (mid-stream).
   * Defaults to {@link DEFAULT_THINKING_IDLE_TIMEOUT_MS}. Must be ≥ the
   * ordinary idle timeout to be useful; smaller values are clamped up.
   */
  thinkingIdleTimeoutMs?: number
  attemptHardTimeoutMs?: number
  /**
   * Pre-stream deadline in ms (attempt start → first response body activity:
   * non-empty body bytes via lifecycle hooks; CanonicalEvent is fallback).
   * Defaults to {@link DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS} (120s). Name
   * matches legacy `SendOptions.responseHeadersTimeoutMs`.
   */
  responseHeadersTimeoutMs?: number
  /** Upstream cancellation; linked into the attempt signal. */
  signal?: AbortSignal
  /**
   * Fired once when the watchdog trips, before the tagged error is thrown.
   * The transport wires this to `api.stream-stalled`.
   */
  onStall?: (info: StallInfo) => void
  /**
   * Optional lifecycle control bound once at start. Network wrappers call:
   * - `markHeadersReceived` — headers only (sub-phase); does **not** end pre-stream
   * - `markBodyActivity` — every non-empty response body chunk: first call ends
   *   pre-stream and arms mid-stream idle; later calls refresh mid-stream idle
   *   even when the SSE parser yields no CanonicalEvent (comments/heartbeats).
   *
   * CanonicalEvent yields also refresh mid-stream idle as a fallback when
   * network hooks are absent (unit tests). Byte activity is authoritative.
   */
  onBindPhaseControl?: (ctl: {
    markHeadersReceived: () => void
    markBodyActivity: () => void
  }) => void
}

/**
 * Wrap a canonical attempt with the pre-stream / idle / hard-timeout /
 * truncation watchdog.
 *
 * `makeStream` receives the watchdog-owned `AbortSignal` : it MUST forward
 * it to the underlying transport so an abort tears the HTTP stream down.
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
  const preStreamTimeout = opts.responseHeadersTimeoutMs ?? DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS

  const ac = new AbortController()
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort()
    else opts.signal.addEventListener("abort", () => ac.abort(), { once: true })
  }

  const startedAt = Date.now()
  /** Updated on body bytes and CanonicalEvents after stream has started. */
  let lastEventAt = 0
  let streamStarted = false
  let headersReceived = false
  let messageStopReceived = false
  let reason: WatchdogAbortReason | null = null
  let openThinkingBlocks = 0

  /** First call: pre-stream → mid-stream. Every call: refresh mid-stream idle. */
  const markBodyActivity = (): void => {
    streamStarted = true
    lastEventAt = Date.now()
  }

  opts.onBindPhaseControl?.({
    markHeadersReceived: () => {
      headersReceived = true
    },
    markBodyActivity,
  })

  const effectiveIdleTimeout = (): number =>
    openThinkingBlocks > 0 ? thinkingIdleTimeout : idleTimeout

  const currentStallPhase = (): StallPhase => (streamStarted ? "mid-stream" : "pre-stream")

  const currentSubPhase = (): StallSubPhase | undefined => {
    if (streamStarted) return undefined
    return headersReceived ? "headers-wait-body" : "pre-headers"
  }

  const timer = setInterval(() => {
    if (messageStopReceived || ac.signal.aborted || reason !== null) return
    const elapsedMs = Date.now() - startedAt

    if (!streamStarted) {
      // Pre-stream: only the long TTFB/upload budget + hard ceiling.
      // Do NOT apply mid-stream idle here (MA-882492).
      if (elapsedMs >= preStreamTimeout) {
        reason = "stream_idle"
        ac.abort()
      } else if (elapsedMs >= hardTimeout) {
        reason = "attempt_too_long"
        ac.abort()
      }
      return
    }

    const idleMs = Date.now() - lastEventAt
    if (idleMs >= effectiveIdleTimeout()) {
      reason = "stream_idle"
      ac.abort()
    } else if (elapsedMs >= hardTimeout) {
      reason = "attempt_too_long"
      ac.abort()
    }
  }, 1000)
  if (typeof timer.unref === "function") timer.unref()

  const fail = (code: WatchdogAbortReason): WatchdogError => {
    const phase = currentStallPhase()
    const sub = currentSubPhase()
    const idleMs = streamStarted ? Date.now() - lastEventAt : Date.now() - startedAt
    const elapsedMs = Date.now() - startedAt
    const message =
      code === "stream_idle"
        ? phase === "pre-stream"
          ? `no response body activity for ${(elapsedMs / 1000).toFixed(1)}s — aborting (stalled pre-stream: upload/TTFB/headers, no SSE yet)`
          : `no SSE event received for ${(idleMs / 1000).toFixed(1)}s — aborting (stalled mid-stream, no message_stop)`
        : code === "attempt_too_long"
          ? `attempt exceeded ${(elapsedMs / 1000).toFixed(0)}s — aborting`
          : `stream ended without message_stop after ${(elapsedMs / 1000).toFixed(1)}s (server truncated the SSE response)`
    opts.onStall?.({
      reason: code,
      idleMs,
      elapsedMs,
      stallPhase: phase,
      stallSubPhase: sub,
    })
    return makeWatchdogError(code, message, phase, sub)
  }

  try {
    for await (const ev of makeStream(ac.signal)) {
      if (reason !== null) throw fail(reason)

      // Fallback body-phase transition / idle refresh when network hooks absent.
      markBodyActivity()
      if (ev.type === "thinking_start") openThinkingBlocks++
      else if (ev.type === "thinking_stop" && openThinkingBlocks > 0) openThinkingBlocks--
      if (ev.type === "message_stop") messageStopReceived = true
      yield ev
    }
  } catch (err) {
    if (reason !== null) throw fail(reason)
    throw err
  } finally {
    clearInterval(timer)
  }

  if (!messageStopReceived) {
    // Clean close without terminator. If we never saw body activity, classify
    // as pre-stream idle-shaped truncation still carries phase for retry.
    throw fail(reason ?? "stream_truncated")
  }
}

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
 *      `responseHeadersTimeoutMs` (default **120s**; the transport passes
 *      60 s remote / 120 s local, and 120 s after the headers arrive; see
 *      `stream-timeouts.ts`). Mid-stream idle does **not** arm in this
 *      phase — that was the Emily/Sarah thrash bug.
 *   1. **mid-stream idle** : after first body activity, silence between
 *      body bytes / CanonicalEvents. Fires `stream_idle` with
 *      `stallPhase: "mid-stream"` after `streamIdleTimeoutMs` (or the longer
 *      silent-block budget while a thinking or tool-input block is open).
 *   2. **hard timeout** : a single attempt runs past `attemptHardTimeoutMs`.
 *      Fires `attempt_too_long`.
 *   3. **truncation** : the body closes cleanly but `message_stop` never
 *      arrived. Fires `stream_truncated`.
 *
 * # Silent-block-aware idle (Grok / OpenAI Responses 37b74c04, Anthropic a8f44b2f)
 *
 * Some blocks legitimately go silent for a long time while the model is
 * healthy:
 *
 * - **thinking**: reasoning models pause 30s+ between summary deltas, and
 *   Anthropic with the thinking display omitted sends no bytes at all until
 *   the block's signature arrives (30-55s observed in session a8f44b2f);
 * - **tool input**: a large tool call input (a 133 KB `Write`) can arrive as
 *   one late burst after 17s+ of silence.
 *
 * While such a block is open we use {@link DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS}
 * (5 min; 90 s after a canonical `ping` inside an open silent block, see
 * `keepaliveSilentBlockIdleTimeoutMs`) instead of the ordinary mid-stream
 * idle budget. Which block is open comes from the shared {@link StreamBlockTracker}, the same fold that feeds
 * the live status, so the watchdog and the host's status row agree.
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

import { type StreamBlockState, StreamBlockTracker } from "./stream-block-tracker.ts"

/** Default mid-stream idle timeout : matches `SendOptions.streamIdleTimeoutMs`. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000
/**
 * Idle budget while a silent-tolerant block (thinking, tool input) is open
 * (mid-stream only).
 *
 * Reasoning streams often go silent for well over 30s while the model is
 * still working. Five minutes still catches a true hang; the hard attempt
 * ceiling remains the ultimate bound.
 */
export const DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS = 5 * 60_000
/** Default hard per-attempt ceiling : matches `SendOptions.attemptHardTimeoutMs`. */
export const DEFAULT_ATTEMPT_HARD_TIMEOUT_MS = 30 * 60_000
/**
 * Default pre-stream deadline (attempt start → first response body activity)
 * when the caller gives none. The transport passes its own values (remote
 * 60 s, local 120 s, 120 s after the headers; see `stream-timeouts.ts`).
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
  /** The budget that tripped (ms): the idle, pre-stream or hard limit. */
  budgetMs: number
}

/** Lifecycle control the watchdog hands to the network wrapper. */
export interface WatchdogPhaseControl {
  markHeadersReceived: () => void
  markBodyActivity: () => void
  /**
   * Replace the pre-stream deadline (ms from attempt start) while still in
   * pre-stream. The transport calls it when the request URL is known, so a
   * local endpoint can keep a longer budget than a remote one.
   */
  setResponseHeadersTimeoutMs: (ms: number) => void
  /**
   * Replace the pre-stream deadline (ms from attempt start) that applies
   * after the headers arrived (sub-phase `headers-wait-body`).
   */
  setHeadersWaitBodyTimeoutMs: (ms: number) => void
}

export interface WatchdogOptions {
  streamIdleTimeoutMs?: number
  /**
   * Idle budget while a thinking or tool-input block is open (mid-stream).
   * Defaults to {@link DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS}. Must be ≥ the
   * ordinary idle timeout to be useful; smaller values are clamped up.
   */
  silentBlockIdleTimeoutMs?: number
  /**
   * Silent-block budget once the attempt has yielded a canonical `ping` event
   * while a silent block was open (the wire has proven a periodic keepalive,
   * so a shorter budget is safe). A ping outside a silent block does not
   * count. Defaults to the silent-block budget (no change). Clamped up to the
   * ordinary idle.
   */
  keepaliveSilentBlockIdleTimeoutMs?: number
  /**
   * Block tracker to fold the attempt's events into. Pass one to share it
   * with another reader; by default the watchdog makes its own. Must be fresh
   * for each attempt.
   */
  blocks?: StreamBlockTracker
  /**
   * Called after every event the watchdog yields, with the block state and
   * the idle budget now in force. `changed` is true when the phase or tool
   * changed. The transport uses this to publish live status facts.
   */
  onBlockState?: (state: StreamBlockState & { idleBudgetMs: number }, changed: boolean) => void
  attemptHardTimeoutMs?: number
  /**
   * Pre-stream deadline in ms (attempt start → first response body activity:
   * non-empty body bytes via lifecycle hooks; CanonicalEvent is fallback).
   * Defaults to {@link DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS} (120s for the
   * bare watchdog; the transport passes 60 s remote / 120 s local, see
   * `stream-timeouts.ts`). Name matches legacy
   * `SendOptions.responseHeadersTimeoutMs`.
   */
  responseHeadersTimeoutMs?: number
  /**
   * Pre-stream deadline in ms from attempt start once the headers arrived
   * (sub-phase `headers-wait-body`). Defaults to `responseHeadersTimeoutMs`.
   */
  headersWaitBodyTimeoutMs?: number
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
  onBindPhaseControl?: (ctl: WatchdogPhaseControl) => void
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
  const silentBlockIdleTimeout = Math.max(
    idleTimeout,
    opts.silentBlockIdleTimeoutMs ?? DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS,
  )
  const keepaliveSilentBlockIdleTimeout = Math.max(
    idleTimeout,
    opts.keepaliveSilentBlockIdleTimeoutMs ?? silentBlockIdleTimeout,
  )
  const hardTimeout = opts.attemptHardTimeoutMs ?? DEFAULT_ATTEMPT_HARD_TIMEOUT_MS
  let preStreamTimeout = opts.responseHeadersTimeoutMs ?? DEFAULT_RESPONSE_HEADERS_TIMEOUT_MS
  let headersWaitBodyTimeout: number | undefined = opts.headersWaitBodyTimeoutMs

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
  /** True after a canonical `ping` event inside an open silent block. */
  let keepaliveSeen = false
  let reason: WatchdogAbortReason | null = null
  let failure: WatchdogError | null = null
  const blocks = opts.blocks ?? new StreamBlockTracker()

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
    setResponseHeadersTimeoutMs: (ms) => {
      if (Number.isFinite(ms) && ms > 0) preStreamTimeout = ms
    },
    setHeadersWaitBodyTimeoutMs: (ms) => {
      if (Number.isFinite(ms) && ms > 0) headersWaitBodyTimeout = ms
    },
  })

  /** Pre-stream deadline in force: longer once the server sent the headers. */
  const currentPreStreamTimeout = (): number =>
    headersReceived ? (headersWaitBodyTimeout ?? preStreamTimeout) : preStreamTimeout

  const effectiveIdleTimeout = (): number =>
    blocks.isSilentBlockOpen()
      ? keepaliveSeen
        ? keepaliveSilentBlockIdleTimeout
        : silentBlockIdleTimeout
      : idleTimeout

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
      if (elapsedMs >= currentPreStreamTimeout()) {
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
    // Single-fire: try-path and catch-path both call fail(reason). Without
    // this, every mid-stream stall logs api.stream-stalled twice (Sergio +
    // Benjamin Grok sessions).
    if (failure !== null) return failure
    const phase = currentStallPhase()
    const sub = currentSubPhase()
    const idleMs = streamStarted ? Date.now() - lastEventAt : Date.now() - startedAt
    const elapsedMs = Date.now() - startedAt
    const message =
      code === "stream_idle"
        ? phase === "pre-stream"
          ? `no response body activity for ${(elapsedMs / 1000).toFixed(1)}s — aborting (stalled pre-stream: upload/TTFB/headers, no SSE yet)`
          : `no response body activity for ${(idleMs / 1000).toFixed(1)}s — aborting (stalled mid-stream, no message_stop)`
        : code === "attempt_too_long"
          ? `attempt exceeded ${(elapsedMs / 1000).toFixed(0)}s — aborting`
          : `stream ended without message_stop after ${(elapsedMs / 1000).toFixed(1)}s (server truncated the SSE response)`
    const budgetMs =
      code === "attempt_too_long"
        ? hardTimeout
        : phase === "pre-stream"
          ? currentPreStreamTimeout()
          : effectiveIdleTimeout()
    opts.onStall?.({
      reason: code,
      idleMs,
      elapsedMs,
      stallPhase: phase,
      stallSubPhase: sub,
      budgetMs,
    })
    failure = makeWatchdogError(code, message, phase, sub)
    return failure
  }

  try {
    for await (const ev of makeStream(ac.signal)) {
      if (reason !== null) throw fail(reason)

      // Fallback body-phase transition / idle refresh when network hooks absent.
      markBodyActivity()
      // Only a ping INSIDE an open silent block proves a periodic keepalive.
      // Check before observe(): a codec can map a role-only first chunk to a
      // ping, and that proves nothing about later pings.
      if (ev.type === "ping" && blocks.isSilentBlockOpen()) keepaliveSeen = true
      const changed = blocks.observe(ev)
      opts.onBlockState?.({ ...blocks.snapshot(), idleBudgetMs: effectiveIdleTimeout() }, changed)
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

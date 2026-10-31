/**
 * Retry policy for failed model requests: pure functions, no I/O.
 *
 * - {@link classifyError} reads the {@link ErrorClass} an adapter stamped on
 *   a thrown error. Errors from vendored adapters that carry only the older
 *   retry tags get the same class from those tags, so every error is decided
 *   by class, never by provider strings.
 * - {@link retryDelayMs} picks the wait before the next attempt. `Retry-After`
 *   wins when present. Otherwise the wait is exponential backoff with full
 *   jitter, capped by a ceiling (default 60 s).
 *
 * There is no attempt limit. The attempt number only grows the backoff.
 * The agent loop (`AgentCore.run`) and the side-call retry (`withRetry`) both
 * use this module, so the two pick the same delays for the same error.
 *
 * @module llm/transport/retry-policy
 */

import type {
  ErrorClass,
  ErrorClassFields,
  RecoveryAction,
} from "@minimal-agent/core/plugin-api/llm/errors"
import { abortableSleep } from "@minimal-agent/core/plugin-api/utils/retry"

import { tagTransientNetworkError } from "../../network/index.ts"

export type { ErrorClass, RecoveryAction }

import {
  type AttemptProgress,
  decideTerminalLessRecovery,
  readAttemptProgress,
} from "./attempt-progress.ts"

/** Default ceiling for one backoff wait. `Retry-After` and quota waits ignore it. */
export const DEFAULT_RETRY_CEILING_MS = 60_000

/** Tag of a stream that closed with no terminal event (stop-table row 8). */
export const TERMINAL_LESS_TAG = "stream_closed_without_terminal"

/**
 * Retry tags that are `transient` when the error carries no explicit class.
 * Membership only marks the error transient; {@link SLOW_RETRY_TAGS} picks
 * the curve.
 *
 * `stream_truncated` is intentionally absent. A server that closes the SSE
 * stream without a terminator usually made a refusal or content-filter
 * decision, and the same prompt gets the same answer (session 81adb696).
 */
const TRANSIENT_TAGS: ReadonlySet<string> = new Set([
  "overloaded_error",
  "api_error",
  "stream_idle",
  "attempt_too_long",
  "network_error",
  TERMINAL_LESS_TAG,
  "rate_limit_error",
])

/** Tags on the slow curve: a 429 waits the limit window out instead of hammering it. */
const SLOW_RETRY_TAGS: ReadonlySet<string> = new Set(["rate_limit_error"])

const RECOVERY_ACTIONS: ReadonlySet<string> = new Set<RecoveryAction>([
  "refresh_credential",
  "compact",
  "wait_for_quota",
])

const FAST_BASE_DELAY_MS = 200
const SLOW_BASE_DELAY_MS = 30_000
/** Floor for pre-stream stalls so multi-MB bodies are not re-sent every ~100ms (MA-882492). */
const PRE_STREAM_BASE_DELAY_MS = 2_000

/** A thrown error with its class resolved. */
export interface ClassifiedError {
  errorClass: ErrorClass
  /** Short cause code: the retry tag, or the class when the error has no tag. */
  cause: string
  /** Set when `errorClass` is `recoverable`. */
  recovery?: RecoveryAction
  /** Server-mandated wait in ms (`Retry-After`). */
  retryAfterMs?: number
  /** Quota reset time, epoch ms. */
  resetAt?: number
  /** Watchdog stall phase, for the pre-stream curve. */
  stallPhase?: "pre-stream" | "mid-stream"
  /** What the failed attempt produced, for the terminal-less curve. */
  progress?: AttemptProgress
  /** The original thrown value. */
  error: unknown
}

/** Which curve produced a delay (diagnostics only). */
export type RetryCurve =
  | "retry-after"
  | "fast"
  | "slow"
  | "pre-stream"
  | "terminal-less-empty"
  | "terminal-less-midstream"

/** Clock seam: tests inject one so no test really waits. */
export interface RetryClock {
  now(): number
  /** Resolve after `ms`, or reject when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

/** The real clock. */
export const SYSTEM_CLOCK: RetryClock = { now: () => Date.now(), sleep: abortableSleep }

/** Tunables shared by the loop and the side-call retry. All optional. */
export interface RetryPolicyOptions {
  clock?: RetryClock
  /** Ceiling for one backoff wait, in ms. Default {@link DEFAULT_RETRY_CEILING_MS}. */
  ceilingMs?: number
  /** Jitter source in [0, 1). Default `Math.random`. */
  random?: () => number
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "AbortError"
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function readStallPhase(err: unknown): "pre-stream" | "mid-stream" | undefined {
  const p = (err as { stallPhase?: unknown } | null)?.stallPhase
  return p === "pre-stream" || p === "mid-stream" ? p : undefined
}

function readClass(v: unknown): ErrorClass | undefined {
  return v === "transient" || v === "recoverable" || v === "permanent" ? v : undefined
}

/**
 * Resolve the class of a thrown error.
 *
 * The class an adapter stamped on the error wins. Without one, the older
 * fields decide: `retryable: false` is permanent, a known retry tag (or
 * `retryable: true`) is transient. Connection-level failures with no tag are
 * tagged `network_error` first.
 *
 * @returns The classified error, or `undefined` for a user abort or an error
 *   with no class (a bug, which the caller rethrows).
 */
export function classifyError(err: unknown): ClassifiedError | undefined {
  if (err == null || isAbortError(err)) return undefined
  const tagged: unknown = tagTransientNetworkError(err)
  const e = tagged as ErrorClassFields & { streamErrorType?: unknown; retryable?: unknown }
  const tag = typeof e.streamErrorType === "string" ? e.streamErrorType : undefined
  const progress = readAttemptProgress(tagged)
  const stallPhase = readStallPhase(tagged)
  const retryAfterMs = finiteNumber(e.retryAfterMs)
  const resetAt = finiteNumber(e.resetAt)
  const make = (errorClass: ErrorClass, recovery?: RecoveryAction): ClassifiedError => ({
    errorClass,
    cause: tag ?? errorClass,
    ...(recovery ? { recovery } : {}),
    ...(retryAfterMs !== undefined && retryAfterMs >= 0 ? { retryAfterMs } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(stallPhase ? { stallPhase } : {}),
    ...(progress ? { progress } : {}),
    error: err,
  })

  // After complete tool calls the request body must never be sent again
  // (the transcript would diverge). The bridge normally salvages this case.
  if (tag === TERMINAL_LESS_TAG && (progress?.completedToolCalls ?? 0) > 0) {
    return make("permanent")
  }

  const explicit = readClass(e.errorClass)
  if (explicit === "recoverable") {
    const recovery = typeof e.recovery === "string" ? e.recovery : undefined
    // A recoverable error with no known action is retried as transient.
    if (recovery !== undefined && RECOVERY_ACTIONS.has(recovery)) {
      return make("recoverable", recovery as RecoveryAction)
    }
    return make("transient")
  }
  if (explicit) return make(explicit)

  // No class on the error: derive it from the older retry fields.
  if (e.retryable === false) return make("permanent")
  if (tag !== undefined && TRANSIENT_TAGS.has(tag)) return make("transient")
  if (e.retryable === true) return make("transient")
  return undefined
}

/**
 * The wait before the next attempt of a transient (or recovered) error.
 *
 * - `Retry-After` wins when present.
 * - A terminal-less close uses the progress-aware curve (a multi-second floor
 *   once the model was already producing output).
 * - Otherwise full jitter over `base * 2^(attempt-1)`, capped by the ceiling.
 *   429s use the slow base (30 s). Pre-stream stalls keep a 2 s floor.
 *
 * @param c - The classified error.
 * @param attempt - 1-based attempt that just failed. It only grows the backoff.
 */
export function retryDelayMs(
  c: ClassifiedError,
  attempt: number,
  opts: RetryPolicyOptions = {},
): { delayMs: number; curve: RetryCurve } {
  const ceiling = opts.ceilingMs ?? DEFAULT_RETRY_CEILING_MS
  const random = opts.random ?? Math.random
  if (c.retryAfterMs !== undefined) return { delayMs: c.retryAfterMs, curve: "retry-after" }
  if (c.cause === TERMINAL_LESS_TAG) {
    const d = decideTerminalLessRecovery({
      progress: c.progress,
      priorTerminalLessRetries: Math.max(0, attempt - 1),
      jitter: random(),
      ceilingMs: ceiling,
    })
    if (d.kind === "retryTransport") return { delayMs: d.delayMs, curve: d.curve }
  }
  const slow = SLOW_RETRY_TAGS.has(c.cause)
  const preStream = c.stallPhase === "pre-stream" && c.cause === "stream_idle"
  const base = slow ? SLOW_BASE_DELAY_MS : preStream ? PRE_STREAM_BASE_DELAY_MS : FAST_BASE_DELAY_MS
  const exp = Math.min(Math.max(0, attempt - 1), 16)
  const ideal = Math.min(ceiling, base * 2 ** exp)
  const raw = Math.floor(random() * ideal)
  if (preStream) {
    return {
      delayMs: Math.max(Math.min(PRE_STREAM_BASE_DELAY_MS, ceiling), raw),
      curve: "pre-stream",
    }
  }
  return { delayMs: raw, curve: slow ? "slow" : "fast" }
}

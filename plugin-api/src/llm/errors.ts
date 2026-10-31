/**
 * Provider-neutral error hierarchy.
 *
 * Every adapter throws (or yields via `StreamErrorEvent`) one of these.
 * The agent loop and retry coordinator only know about these shapes.
 *
 * Wave D-2 split: the pure error classes and the two classifiers
 * (`categorizeError`, `classifyUpstreamError`) moved here into the leaf
 * contract package (provider-neutral, no host state, no `canonical-request`
 * dependency) so plugins can depend on them without reaching into `src/`.
 * `UnsupportedCapabilityError` STAYS in `src/llm/errors.ts`: it carries a
 * `degrade?: CanonicalRequest` and `canonical-request.ts` has not moved into
 * the package yet (it is a frozen I1 baseline member, relocating in Wave C-3).
 * The `src/` shim re-exports everything here plus that one class.
 *
 * @module llm/errors
 */

import type { Capabilities } from "./capabilities.ts"

// ---------------------------------------------------------------------------
// Error classes (data, not branches)
// ---------------------------------------------------------------------------

/**
 * How the agent loop treats a failed request. Adapters put it on the error as
 * data, so the loop decides from this field and never from provider strings.
 *
 * - `transient`: retry forever with backoff (network error, 5xx, 429,
 *   overload, stream timeout, terminal-less close).
 * - `recoverable`: run one {@link RecoveryAction}, then retry.
 * - `permanent`: pause the run and wait for the host (revoked credential,
 *   invalid request, unknown model, billing exhausted).
 */
export type ErrorClass = "transient" | "recoverable" | "permanent"

/** The action the loop runs for a `recoverable` error before it retries. */
export type RecoveryAction = "refresh_credential" | "compact" | "wait_for_quota"

/** Class data an adapter stamps on a thrown error (all optional, duck typed). */
export interface ErrorClassFields {
  errorClass?: ErrorClass
  recovery?: RecoveryAction
  /** Server-mandated wait from `Retry-After`, in ms. Wins over backoff. */
  retryAfterMs?: number
  /** Quota reset time, epoch ms. Used with `recovery: "wait_for_quota"`. */
  resetAt?: number
}

/**
 * Parse an HTTP `Retry-After` value (delta-seconds or an HTTP-date) into ms.
 * Returns `undefined` for a missing or malformed value.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (value == null) return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000)
  // An HTTP-date names its weekday and month; anything else is malformed.
  if (!/[a-z]/i.test(text)) return undefined
  const at = Date.parse(text)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - nowMs)
}

/**
 * Copy a {@link classifyUpstreamError} result onto an error: the retry tag
 * (`streamErrorType`, when there is one) and the class fields. Returns the
 * same error.
 */
export function tagUpstreamError<E extends Error>(
  err: E,
  c: ErrorClassFields & { streamErrorType?: string },
): E & ErrorClassFields & { streamErrorType?: string } {
  const out = err as E & ErrorClassFields & { streamErrorType?: string }
  if (c.streamErrorType !== undefined) out.streamErrorType = c.streamErrorType
  if (c.errorClass !== undefined) out.errorClass = c.errorClass
  if (c.recovery !== undefined) out.recovery = c.recovery
  if (c.retryAfterMs !== undefined) out.retryAfterMs = c.retryAfterMs
  if (c.resetAt !== undefined) out.resetAt = c.resetAt
  return out
}

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

/**
 * Base for all provider-raised errors. `retryable` lets the outer
 * coordinator decide without string-matching messages.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly opts: {
      status?: number
      retryable?: boolean
      upstreamCode?: string
      requestId?: string
      cause?: unknown
      /** One-line next step for the user. Core renders it on its own dim line. */
      hint?: string
      /** Stable machine code (for example `opencode.free_tier_gate`). */
      code?: string
    } & ErrorClassFields = {},
  ) {
    super(message)
    this.name = "ProviderError"
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause
    if (opts.hint !== undefined) this.hint = opts.hint
    if (opts.code !== undefined) this.code = opts.code
    // The class defaults from `retryable` so older call sites stay classified.
    const errorClass =
      opts.errorClass ??
      (opts.retryable === true ? "transient" : opts.retryable === false ? "permanent" : undefined)
    if (errorClass !== undefined) this.errorClass = errorClass
    if (opts.recovery !== undefined) this.recovery = opts.recovery
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
    if (opts.resetAt !== undefined) this.resetAt = opts.resetAt
  }

  /**
   * One-line user next step. Core reads any thrown error with a string `hint`
   * property (duck typed), so vendored copies of this class work too.
   */
  readonly hint?: string
  /** Stable machine code, kept in session logs and observer payloads. */
  readonly code?: string
  /** How the loop treats this error. See {@link ErrorClass}. */
  readonly errorClass?: ErrorClass
  /** Recovery for a `recoverable` error. */
  readonly recovery?: RecoveryAction
  /** Server-mandated wait in ms (from `Retry-After`). */
  readonly retryAfterMs?: number
  /** Quota reset time, epoch ms. */
  readonly resetAt?: number
}

// ---------------------------------------------------------------------------
// Validation / capability errors
// ---------------------------------------------------------------------------

/**
 * One specific capability the request asked for but the model doesn't
 * support. Multiple are aggregated under
 * {@link UnsupportedCapabilityError.violations}.
 */
export class CapabilityViolation extends Error {
  constructor(
    /** Field name on `Capabilities`, or a sub-key like `"thinking.extended"`. */
    public readonly capability: keyof Capabilities | (string & {}),
    /** Plain-language explanation of why it doesn't fit. */
    public readonly detail: string,
  ) {
    super(`capability violation: ${capability}: ${detail}`)
    this.name = "CapabilityViolation"
  }
}

// ---------------------------------------------------------------------------
// Streaming errors
// ---------------------------------------------------------------------------

/**
 * Server stopped sending events for too long (the per-attempt idle
 * watchdog fired). Always retryable : the outer coordinator opens a
 * fresh request.
 */
export class StreamIdleError extends ProviderError {
  constructor(
    providerId: string,
    public readonly idleMs: number,
  ) {
    super(`stream idle for ${idleMs}ms`, providerId, { retryable: true })
    this.name = "StreamIdleError"
  }
}

/**
 * One attempt blew through its hard wall-clock budget. Belt-and-suspenders
 * against pathological hangs. Retryable.
 */
export class StreamHardTimeoutError extends ProviderError {
  constructor(
    providerId: string,
    public readonly attemptMs: number,
  ) {
    super(`attempt exceeded hard timeout (${attemptMs}ms)`, providerId, { retryable: true })
    this.name = "StreamHardTimeoutError"
  }
}

/**
 * Server returned a 5xx the SDK considers retryable, or an SSE `error`
 * event of category `overloaded_error` / `api_error`. Retryable.
 */
export class RetryableServerError extends ProviderError {
  constructor(providerId: string, message: string, status?: number, upstreamCode?: string) {
    super(message, providerId, { retryable: true, status, upstreamCode })
    this.name = "RetryableServerError"
  }
}

/**
 * Auth failed and refresh either isn't configured or failed.
 * Not retryable here : the host should re-login.
 */
export class AuthError extends ProviderError {
  constructor(providerId: string, message: string) {
    super(message, providerId, { retryable: false, status: 401 })
    this.name = "AuthError"
  }
}

// ---------------------------------------------------------------------------
// Categorization helper
// ---------------------------------------------------------------------------

/**
 * Map an unknown thrown value to the canonical `StreamErrorEvent.category`
 * the agent loop reports to its observers.
 */
export function categorizeError(err: unknown): {
  category: "overloaded" | "api" | "timeout" | "canceled" | "auth" | "unknown"
  retryable: boolean
} {
  if (err instanceof StreamIdleError || err instanceof StreamHardTimeoutError) {
    return { category: "timeout", retryable: true }
  }
  if (err instanceof AuthError) return { category: "auth", retryable: false }
  if (err instanceof RetryableServerError) {
    return { category: "overloaded", retryable: true }
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    return { category: "canceled", retryable: false }
  }
  if (err instanceof ProviderError) {
    return { category: "api", retryable: err.opts.retryable ?? false }
  }
  return { category: "unknown", retryable: false }
}

// ---------------------------------------------------------------------------
// Upstream → canonical stream-error tag classifier
// ---------------------------------------------------------------------------

/** Canonical `StreamErrorEvent.category` values. */
export type StreamErrorCategory =
  | "overloaded"
  | "api"
  | "timeout"
  | "rate_limit"
  | "billing"
  | "canceled"
  | "auth"
  | "unknown"

/** Input for {@link classifyUpstreamError}. Every field is optional. */
export interface UpstreamErrorInput {
  httpStatus?: number
  upstreamCode?: unknown
  /** Raw `Retry-After` header value from the failed response. */
  retryAfter?: string | null
  /** Quota reset time (epoch ms) the provider reported, when known. */
  resetAt?: number
  /**
   * The adapter recognized a context-window overflow in the error body (for
   * example a 400 whose message says the prompt is too long). The adapter
   * reads its own wire text; this classifier never matches messages.
   */
  contextOverflow?: boolean
  /** Clock for an HTTP-date `Retry-After` and for `resetAt`. */
  nowMs?: number
}

/** Result of {@link classifyUpstreamError}. */
export interface UpstreamErrorClassification extends ErrorClassFields {
  streamErrorType?: string
  category: StreamErrorCategory
  retryable: boolean
  errorClass: ErrorClass
}

/**
 * The single source of truth for mapping a provider's error surface (an
 * upstream error code and/or a non-2xx HTTP status) onto the canonical
 * `streamErrorType` tag, the observer-facing `category`, a `retryable` hint,
 * and the {@link ErrorClass} the agent loop decides from.
 *
 * Every provider adapter funnels its wire errors through here so they get
 * the SAME class regardless of vendor wire shape. Stamp the result on the
 * thrown error with {@link tagUpstreamError}.
 *
 * Classes:
 *   - `transient`: 429 / `rate_limit_*` (tag `rate_limit_error`, slow curve),
 *     5xx / `overloaded` / `server_error` (tag `overloaded_error`), and
 *     408 / `timeout` (tag `api_error`). `Retry-After` becomes `retryAfterMs`.
 *   - `recoverable`: 401 (`refresh_credential`), a context overflow (413,
 *     `context_length_exceeded`, or `contextOverflow`; `compact`), and a
 *     quota rejection with a known future `resetAt` (`wait_for_quota`).
 *   - `permanent`: billing / quota exhaustion with no reset, 400, 403, 404,
 *     and every other non-2xx. They are deterministic until the caller
 *     changes credentials, configuration, or the request.
 *
 * Billing exhaustion is TERMINAL, not a rate limit. A provider may return
 * `insufficient_quota` over a 200 SSE error frame, and it repeats every
 * request until the account is topped up. Waiting does NOT clear it
 * (session 50efb996, 2026-05-30: 36 identical insufficient_quota failures).
 */
export function classifyUpstreamError(input: UpstreamErrorInput): UpstreamErrorClassification {
  // Provider error payloads are untrusted JSON. Several gateways use a
  // number or object for `error.code`, so never call string methods blindly.
  const code = typeof input.upstreamCode === "string" ? input.upstreamCode.toLowerCase() : undefined
  const status = input.httpStatus
  const nowMs = input.nowMs ?? Date.now()
  const retryAfterMs = parseRetryAfterMs(input.retryAfter, nowMs)
  const waitFields = retryAfterMs !== undefined ? { retryAfterMs } : {}
  const quotaReset =
    input.resetAt !== undefined && Number.isFinite(input.resetAt) && input.resetAt > nowMs
      ? input.resetAt
      : undefined

  if (
    code === "insufficient_quota" ||
    code === "billing_hard_limit_reached" ||
    code?.includes("billing") ||
    code?.includes("quota_exceeded")
  ) {
    if (quotaReset !== undefined) {
      return {
        streamErrorType: undefined,
        category: "billing",
        retryable: false,
        errorClass: "recoverable",
        recovery: "wait_for_quota",
        resetAt: quotaReset,
      }
    }
    return {
      streamErrorType: undefined,
      category: "billing",
      retryable: false,
      errorClass: "permanent",
    }
  }

  // Rate limits: explicit code OR HTTP 429. They clear once the window rolls.
  // A known reset time turns the wait into a quota wait instead of backoff.
  if (status === 429 || (code && (code.includes("rate_limit") || code.includes("rate-limit")))) {
    if (quotaReset !== undefined) {
      return {
        streamErrorType: "rate_limit_error",
        category: "rate_limit",
        retryable: true,
        errorClass: "recoverable",
        recovery: "wait_for_quota",
        resetAt: quotaReset,
        ...waitFields,
      }
    }
    return {
      streamErrorType: "rate_limit_error",
      category: "rate_limit",
      retryable: true,
      errorClass: "transient",
      ...waitFields,
    }
  }

  // Server overload / transient 5xx.
  if (
    (status !== undefined && status >= 500) ||
    code === "overloaded_error" ||
    code === "overloaded" ||
    code === "server_error" ||
    code === "service_unavailable"
  ) {
    return {
      streamErrorType: "overloaded_error",
      category: "overloaded",
      retryable: true,
      errorClass: "transient",
      ...waitFields,
    }
  }

  // Request timeout.
  if (status === 408 || code === "timeout" || code === "api_error") {
    return {
      streamErrorType: "api_error",
      category: "api",
      retryable: true,
      errorClass: "transient",
      ...waitFields,
    }
  }

  // 401 has no retry tag: the auth-refresh layer owns it. The class asks the
  // loop to refresh the credential once before it gives up.
  if (status === 401 || code === "authentication_error" || code === "invalid_api_key") {
    return {
      streamErrorType: undefined,
      category: "auth",
      retryable: false,
      errorClass: "recoverable",
      recovery: "refresh_credential",
    }
  }

  // Context overflow: compacting the history makes the same request fit.
  if (
    input.contextOverflow === true ||
    status === 413 ||
    code === "context_length_exceeded" ||
    code === "context_window_exceeded" ||
    code === "request_too_large"
  ) {
    return {
      streamErrorType: undefined,
      category: "api",
      retryable: false,
      errorClass: "recoverable",
      recovery: "compact",
    }
  }

  if (status === 400 || code === "invalid_request_error" || code?.startsWith("invalid_request")) {
    return {
      streamErrorType: undefined,
      category: "api",
      retryable: false,
      errorClass: "permanent",
    }
  }
  if (status === 404 || code === "not_found_error") {
    return {
      streamErrorType: undefined,
      category: "api",
      retryable: false,
      errorClass: "permanent",
    }
  }
  if (status === 403 || code === "permission_error") {
    return {
      streamErrorType: undefined,
      category: "api",
      retryable: false,
      errorClass: "permanent",
    }
  }

  return {
    streamErrorType: undefined,
    category: "unknown",
    retryable: false,
    errorClass: "permanent",
  }
}

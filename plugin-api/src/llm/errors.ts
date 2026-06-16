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
    } = {},
  ) {
    super(message)
    this.name = "ProviderError"
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause
  }
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

/**
 * The single source of truth for mapping a provider's error surface (an
 * upstream error code and/or a non-2xx HTTP status) onto the canonical
 * `streamErrorType` tag the retry coordinator keys on, plus the
 * observer-facing `category` and a `retryable` hint.
 *
 * Every provider adapter funnels its rate-limit / overload / transient
 * failures through here so they retry on the SAME curves regardless of
 * vendor wire shape. The retry loops in `client.ts` and
 * `transport/retry.ts` own the curve selection (fast vs slow); this only
 * decides the TAG. A tag those loops don't know about (or `undefined` here)
 * means "propagate" — a genuine, non-transient failure.
 *
 * Recognized normalized tags:
 *   - `rate_limit_error` — 429 / `rate_limit_*` / `*_quota_*` (slow curve).
 *   - `overloaded_error` — 5xx / `overloaded` / `server_error` (fast curve).
 *   - `api_error`        — 408 / `timeout` (fast curve).
 *   - `rate_limit_error` — 429 / `rate_limit_*` / `*_quota_*` (slow curve).
 * 400/403/404 are intentionally NOT retryable: malformed requests, missing
 * permissions, and missing endpoint/resource/model errors are deterministic
 * until the caller changes configuration or provider routing.
 * 401 is intentionally NOT mapped: the auth-refresh layer owns it, and a
 * retry tag would mask a real auth failure.
 */
export function classifyUpstreamError(input: { httpStatus?: number; upstreamCode?: string }): {
  streamErrorType?: string
  category: StreamErrorCategory
  retryable: boolean
} {
  const code = input.upstreamCode?.toLowerCase()
  const status = input.httpStatus

  // Billing / quota exhaustion is TERMINAL, not a rate limit. A provider may
  // return `insufficient_quota` ("You exceeded your current quota, check your
  // plan and billing details") over a 200 SSE error frame, and it repeats every
  // request until the account is topped up — waiting does NOT clear it. A
  // prior fix lumped this into `rate_limit_error` (slow-curve retry), so a
  // dead-broke account spun the forever-retry loop for an hour instead of
  // stopping the turn (session 50efb996, 2026-05-30: 36 identical
  // insufficient_quota failures). Tag it untagged + retryable:false so it
  // propagates and the user sees the real "out of quota" error.
  if (
    code === "insufficient_quota" ||
    code === "billing_hard_limit_reached" ||
    code?.includes("billing") ||
    code?.includes("quota_exceeded")
  ) {
    return { streamErrorType: undefined, category: "billing", retryable: false }
  }

  // Rate limits: explicit code OR HTTP 429. Providers use a `rate_limit_*`
  // family of codes. Unlike billing exhaustion above, these clear once the
  // window rolls, so they retry on the slow curve.
  if (status === 429 || (code && (code.includes("rate_limit") || code.includes("rate-limit")))) {
    return { streamErrorType: "rate_limit_error", category: "rate_limit", retryable: true }
  }

  // Server overload / transient 5xx.
  if (
    (status !== undefined && status >= 500) ||
    code === "overloaded_error" ||
    code === "overloaded" ||
    code === "server_error" ||
    code === "service_unavailable"
  ) {
    return { streamErrorType: "overloaded_error", category: "overloaded", retryable: true }
  }

  // Request timeout.
  if (status === 408 || code === "timeout" || code === "api_error") {
    return { streamErrorType: "api_error", category: "api", retryable: true }
  }

  // 401 is owned by the auth-refresh layer; never tag it here.
  if (status === 401 || code === "authentication_error" || code === "invalid_api_key") {
    return { streamErrorType: undefined, category: "auth", retryable: false }
  }

  if (status === 400 || code === "invalid_request_error" || code?.startsWith("invalid_request")) {
    return { streamErrorType: undefined, category: "api", retryable: false }
  }
  if (status === 404 || code === "not_found_error") {
    return { streamErrorType: undefined, category: "api", retryable: false }
  }
  if (status === 403 || code === "permission_error") {
    return { streamErrorType: undefined, category: "api", retryable: false }
  }

  return { streamErrorType: undefined, category: "unknown", retryable: false }
}

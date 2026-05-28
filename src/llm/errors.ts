/**
 * Provider-neutral error hierarchy.
 *
 * Every adapter throws (or yields via `StreamErrorEvent`) one of these.
 * The agent loop and retry coordinator only know about these shapes.
 *
 * @module llm/errors
 */

import type { CanonicalRequest } from "./canonical-request.ts"
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

/**
 * Aggregate raised when `ProviderAdapter.validate` returns a non-empty
 * error list and the caller didn't opt in to a degraded fallback.
 */
export class UnsupportedCapabilityError extends ProviderError {
  constructor(
    public readonly violations: CapabilityViolation[],
    /** Suggested degrade the adapter could send instead, if known. */
    public readonly degrade?: CanonicalRequest,
  ) {
    super(
      `request requires unsupported capabilities: ${violations.map((v) => v.capability).join(", ")}`,
      "_canonical",
      { retryable: false },
    )
    this.name = "UnsupportedCapabilityError"
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

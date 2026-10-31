/**
 * Tests for the provider-neutral upstream-error classifier.
 *
 * `classifyUpstreamError` is the single source of truth mapping a vendor's
 * error surface (HTTP status and/or upstream error code) onto the canonical
 * `streamErrorType` tag the retry coordinator keys on. The retry loops own
 * the curve; this owns the tag vocabulary. These tests pin the mapping so a
 * new provider can't accidentally drop a rate limit on the floor.
 *
 * @module llm/errors.test
 */

import { describe, expect, it } from "bun:test"

import {
  classifyUpstreamError,
  ProviderError,
  parseRetryAfterMs,
  tagUpstreamError,
} from "./errors.ts"

describe("classifyUpstreamError", () => {
  it("maps HTTP 429 to rate_limit_error (retryable, rate_limit category)", () => {
    const r = classifyUpstreamError({ httpStatus: 429 })
    expect(r.streamErrorType).toBe("rate_limit_error")
    expect(r.category).toBe("rate_limit")
    expect(r.retryable).toBe(true)
  })

  it("maps `rate_limit_error` code to rate_limit_error", () => {
    expect(classifyUpstreamError({ upstreamCode: "rate_limit_error" }).streamErrorType).toBe(
      "rate_limit_error",
    )
  })

  it("maps `rate_limit_exceeded` to the retryable rate_limit_error", () => {
    const r = classifyUpstreamError({ upstreamCode: "rate_limit_exceeded" })
    expect(r.streamErrorType).toBe("rate_limit_error")
    expect(r.category).toBe("rate_limit")
    expect(r.retryable).toBe(true)
  })

  it("treats `insufficient_quota` / billing exhaustion as TERMINAL (untagged, retryable:false)", () => {
    // Regression for 2026-05-30 (session 98105c24): one provider returned
    // `insufficient_quota` over a 200 SSE error frame when the account was
    // out of credit. It repeats on every request and waiting never clears it, so
    // it must NOT retry — neither on the fast nor the slow curve. A prior fix
    // lumped it into rate_limit_error and the agent spun for an hour.
    const quota = classifyUpstreamError({ upstreamCode: "insufficient_quota" })
    expect(quota.streamErrorType).toBeUndefined()
    expect(quota.category).toBe("billing")
    expect(quota.retryable).toBe(false)

    const billing = classifyUpstreamError({ upstreamCode: "billing_hard_limit_reached" })
    expect(billing.streamErrorType).toBeUndefined()
    expect(billing.category).toBe("billing")
    expect(billing.retryable).toBe(false)
  })

  it("maps 5xx and overloaded/server_error codes to overloaded_error", () => {
    expect(classifyUpstreamError({ httpStatus: 503 }).streamErrorType).toBe("overloaded_error")
    expect(classifyUpstreamError({ httpStatus: 500 }).streamErrorType).toBe("overloaded_error")
    expect(classifyUpstreamError({ upstreamCode: "overloaded_error" }).streamErrorType).toBe(
      "overloaded_error",
    )
    expect(classifyUpstreamError({ upstreamCode: "server_error" }).streamErrorType).toBe(
      "overloaded_error",
    )
  })

  it("maps 408 / timeout to api_error", () => {
    expect(classifyUpstreamError({ httpStatus: 408 }).streamErrorType).toBe("api_error")
    expect(classifyUpstreamError({ upstreamCode: "timeout" }).streamErrorType).toBe("api_error")
  })

  it("does NOT tag 401 (owned by the auth-refresh layer) — propagates", () => {
    const r = classifyUpstreamError({ httpStatus: 401 })
    expect(r.streamErrorType).toBeUndefined()
    expect(r.category).toBe("auth")
    expect(r.retryable).toBe(false)
  })

  it("treats 400 / invalid_request as terminal", () => {
    const badStatus = classifyUpstreamError({ httpStatus: 400 })
    expect(badStatus.streamErrorType).toBeUndefined()
    expect(badStatus.category).toBe("api")
    expect(badStatus.retryable).toBe(false)

    const badCode = classifyUpstreamError({ upstreamCode: "invalid_request_error" })
    expect(badCode.streamErrorType).toBeUndefined()
    expect(badCode.category).toBe("api")
    expect(badCode.retryable).toBe(false)
  })

  it("treats 403 / 404 / not_found_error as terminal", () => {
    const forbidden = classifyUpstreamError({ httpStatus: 403 })
    expect(forbidden.streamErrorType).toBeUndefined()
    expect(forbidden.category).toBe("api")
    expect(forbidden.retryable).toBe(false)

    const missing = classifyUpstreamError({ httpStatus: 404 })
    expect(missing.streamErrorType).toBeUndefined()
    expect(missing.category).toBe("api")
    expect(missing.retryable).toBe(false)

    const missingCode = classifyUpstreamError({ upstreamCode: "not_found_error" })
    expect(missingCode.streamErrorType).toBeUndefined()
    expect(missingCode.retryable).toBe(false)
  })

  it("tolerates non-string upstream error codes from gateway JSON", () => {
    // OpenRouter and other gateways may expose a numeric or structured
    // `error.code`. Error classification must preserve the original failure,
    // never replace it with a local TypeError from `.toLowerCase()`.
    for (const upstreamCode of [400, { code: "bad_request" }, ["bad_request"], null]) {
      const r = classifyUpstreamError({ upstreamCode })
      expect(r.streamErrorType).toBeUndefined()
      expect(r.category).toBe("unknown")
      expect(r.retryable).toBe(false)
    }
  })

  it("leaves an unknown error untagged so it propagates (does not silently retry forever)", () => {
    const r = classifyUpstreamError({ upstreamCode: "some_new_unmapped_code" })
    expect(r.streamErrorType).toBeUndefined()
    expect(r.category).toBe("unknown")
    expect(r.retryable).toBe(false)
  })

  it("429 takes precedence even if a 5xx-ish code is also present", () => {
    expect(
      classifyUpstreamError({ httpStatus: 429, upstreamCode: "server_error" }).streamErrorType,
    ).toBe("rate_limit_error")
  })
})

describe("classifyUpstreamError error classes", () => {
  const NOW = Date.parse("2026-10-31T12:00:00Z")

  it("classes 429, 5xx, and 408 as transient", () => {
    for (const httpStatus of [429, 500, 502, 503, 529, 408]) {
      expect(classifyUpstreamError({ httpStatus }).errorClass).toBe("transient")
    }
    expect(classifyUpstreamError({ upstreamCode: "overloaded_error" }).errorClass).toBe("transient")
  })

  it("carries Retry-After as retryAfterMs (seconds or HTTP-date)", () => {
    expect(classifyUpstreamError({ httpStatus: 429, retryAfter: "12" }).retryAfterMs).toBe(12_000)
    const date = new Date(NOW + 5_000).toUTCString()
    const r = classifyUpstreamError({ httpStatus: 503, retryAfter: date, nowMs: NOW })
    expect(r.errorClass).toBe("transient")
    expect(r.retryAfterMs).toBe(5_000)
    expect(classifyUpstreamError({ httpStatus: 429, retryAfter: "soon" }).retryAfterMs).toBe(
      undefined,
    )
  })

  it("classes a 429 with a known future reset as a quota wait", () => {
    const r = classifyUpstreamError({ httpStatus: 429, resetAt: NOW + 60_000, nowMs: NOW })
    expect(r.errorClass).toBe("recoverable")
    expect(r.recovery).toBe("wait_for_quota")
    expect(r.resetAt).toBe(NOW + 60_000)
    // A reset in the past is no wait: plain backoff.
    expect(
      classifyUpstreamError({ httpStatus: 429, resetAt: NOW - 1, nowMs: NOW }).errorClass,
    ).toBe("transient")
  })

  it("classes 401 as recoverable (refresh the credential)", () => {
    const r = classifyUpstreamError({ httpStatus: 401 })
    expect(r.errorClass).toBe("recoverable")
    expect(r.recovery).toBe("refresh_credential")
  })

  it("classes a context overflow as recoverable (compact)", () => {
    for (const input of [
      { httpStatus: 400, contextOverflow: true },
      { httpStatus: 413 },
      { httpStatus: 400, upstreamCode: "context_length_exceeded" },
    ]) {
      const r = classifyUpstreamError(input)
      expect(r.errorClass).toBe("recoverable")
      expect(r.recovery).toBe("compact")
    }
  })

  it("classes billing, 400, 403, 404, and unknown errors as permanent", () => {
    for (const input of [
      { upstreamCode: "insufficient_quota" },
      { httpStatus: 400 },
      { httpStatus: 403 },
      { httpStatus: 404 },
      { httpStatus: 418 },
      { upstreamCode: "some_new_unmapped_code" },
    ]) {
      expect(classifyUpstreamError(input).errorClass).toBe("permanent")
    }
  })

  it("tagUpstreamError stamps the tag and class fields on the error", () => {
    const err = tagUpstreamError(
      new Error("x"),
      classifyUpstreamError({ httpStatus: 429, retryAfter: "3" }),
    )
    expect(err.streamErrorType).toBe("rate_limit_error")
    expect(err.errorClass).toBe("transient")
    expect(err.retryAfterMs).toBe(3_000)
  })

  it("ProviderError defaults its class from `retryable`", () => {
    expect(new ProviderError("a", "p", { retryable: true }).errorClass).toBe("transient")
    expect(new ProviderError("a", "p", { retryable: false }).errorClass).toBe("permanent")
    expect(new ProviderError("a", "p").errorClass).toBeUndefined()
    const quota = new ProviderError("a", "p", {
      errorClass: "recoverable",
      recovery: "wait_for_quota",
      resetAt: 5,
    })
    expect(quota.errorClass).toBe("recoverable")
    expect(quota.resetAt).toBe(5)
  })

  it("parseRetryAfterMs ignores missing and malformed values", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs("")).toBeUndefined()
    expect(parseRetryAfterMs("-3")).toBeUndefined()
    expect(parseRetryAfterMs("1.5")).toBe(1_500)
    expect(parseRetryAfterMs(new Date(NOW - 10_000).toUTCString(), NOW)).toBe(0)
  })
})

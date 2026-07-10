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

import { classifyUpstreamError } from "./errors.ts"

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
    // Regression for 2026-05-30 (session 50efb996): one provider returned
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

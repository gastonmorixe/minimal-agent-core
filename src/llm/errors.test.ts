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

  it("maps Anthropic `rate_limit_error` code to rate_limit_error", () => {
    expect(classifyUpstreamError({ upstreamCode: "rate_limit_error" }).streamErrorType).toBe(
      "rate_limit_error",
    )
  })

  it("maps OpenAI `rate_limit_exceeded` and `insufficient_quota` to rate_limit_error", () => {
    expect(classifyUpstreamError({ upstreamCode: "rate_limit_exceeded" }).streamErrorType).toBe(
      "rate_limit_error",
    )
    expect(classifyUpstreamError({ upstreamCode: "insufficient_quota" }).streamErrorType).toBe(
      "rate_limit_error",
    )
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

  it("maps 400 / invalid_request to the slow-curve invalid_request_error", () => {
    expect(classifyUpstreamError({ httpStatus: 400 }).streamErrorType).toBe("invalid_request_error")
    expect(classifyUpstreamError({ upstreamCode: "invalid_request_error" }).streamErrorType).toBe(
      "invalid_request_error",
    )
  })

  it("maps 404 / 403 to their slow-curve tags", () => {
    expect(classifyUpstreamError({ httpStatus: 404 }).streamErrorType).toBe("not_found_error")
    expect(classifyUpstreamError({ httpStatus: 403 }).streamErrorType).toBe("permission_error")
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

/**
 * Tests for the pure retry policy: error classes and retry delays.
 *
 * @module llm/transport/retry-policy.test
 */

import { describe, expect, it } from "bun:test"

import { classifyError, DEFAULT_RETRY_CEILING_MS, retryDelayMs } from "./retry-policy.ts"

describe("classifyError", () => {
  it("reads the class an adapter stamped on the error", () => {
    const err = Object.assign(new Error("x"), {
      errorClass: "recoverable",
      recovery: "wait_for_quota",
      resetAt: 123,
    })
    expect(classifyError(err)).toMatchObject({
      errorClass: "recoverable",
      recovery: "wait_for_quota",
      resetAt: 123,
      cause: "recoverable",
    })
  })

  it("lets the stamped class win over the older retry fields", () => {
    const err = Object.assign(new Error("x"), {
      errorClass: "permanent",
      streamErrorType: "overloaded_error",
    })
    expect(classifyError(err)?.errorClass).toBe("permanent")
  })

  it("derives the class from older tags when no class is stamped", () => {
    const tag = (streamErrorType: string) => Object.assign(new Error("x"), { streamErrorType })
    expect(classifyError(tag("rate_limit_error"))).toMatchObject({
      errorClass: "transient",
      cause: "rate_limit_error",
    })
    expect(classifyError(Object.assign(tag("api_error"), { retryable: false }))?.errorClass).toBe(
      "permanent",
    )
    expect(classifyError(new Error("HTTP/2 connect timeout"))?.cause).toBe("network_error")
    // A refusal-like truncation and an untagged bug have no class.
    expect(classifyError(tag("stream_truncated"))).toBeUndefined()
    expect(classifyError(new Error("genuine bug"))).toBeUndefined()
  })

  it("never resends after complete tool calls (terminal-less close is permanent)", () => {
    const err = Object.assign(new Error("closed"), {
      streamErrorType: "stream_closed_without_terminal",
      attemptProgress: { sawReasoning: false, sawText: false, completedToolCalls: 1 },
    })
    expect(classifyError(err)?.errorClass).toBe("permanent")
  })

  it("treats a recoverable error with no known action as transient", () => {
    const err = Object.assign(new Error("x"), { errorClass: "recoverable", recovery: "pray" })
    expect(classifyError(err)?.errorClass).toBe("transient")
  })

  it("returns undefined for a user abort", () => {
    expect(classifyError(Object.assign(new Error("a"), { name: "AbortError" }))).toBeUndefined()
  })
})

describe("retryDelayMs", () => {
  const transient = (cause: string, extra: object = {}) => ({
    errorClass: "transient" as const,
    cause,
    error: null,
    ...extra,
  })

  it("lets Retry-After win over backoff", () => {
    const c = transient("rate_limit_error", { retryAfterMs: 4_321 })
    expect(retryDelayMs(c, 1, { random: () => 0.9 })).toEqual({
      delayMs: 4_321,
      curve: "retry-after",
    })
    // Retry-After is the server's call: the backoff ceiling does not shorten it.
    expect(retryDelayMs(transient("x", { retryAfterMs: 120_000 }), 1).delayMs).toBe(120_000)
  })

  it("grows with full jitter and holds at the ceiling (default 60 s)", () => {
    const max = () => 0.999999
    expect(retryDelayMs(transient("overloaded_error"), 1, { random: max }).delayMs).toBe(199)
    expect(retryDelayMs(transient("overloaded_error"), 40, { random: max }).delayMs).toBe(
      DEFAULT_RETRY_CEILING_MS - 1,
    )
    expect(retryDelayMs(transient("overloaded_error"), 3, { random: () => 0 }).delayMs).toBe(0)
    expect(
      retryDelayMs(transient("rate_limit_error"), 9, { random: max, ceilingMs: 5_000 }).delayMs,
    ).toBe(4_999)
  })

  it("keeps the 2 s floor for pre-stream stalls and the terminal-less curves", () => {
    const pre = transient("stream_idle", { stallPhase: "pre-stream" })
    expect(retryDelayMs(pre, 1, { random: () => 0 })).toEqual({
      delayMs: 2_000,
      curve: "pre-stream",
    })
    const mid = transient("stream_closed_without_terminal", {
      progress: { sawReasoning: true, sawText: false, completedToolCalls: 0 },
    })
    const d = retryDelayMs(mid, 1, { random: () => 0 })
    expect(d.curve).toBe("terminal-less-midstream")
    expect(d.delayMs).toBeGreaterThanOrEqual(1_000)
  })
})

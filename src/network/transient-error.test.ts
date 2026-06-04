/**
 * Tests for the transient transport-error classifier.
 *
 * Covers the connection-level failures that must feed the forever-retry loop
 * (connect timeout, reset socket, DNS blip, GOAWAY) and the exclusions that
 * must NOT (user aborts, already-tagged stream errors, genuine bugs).
 *
 * @module network/transient-error.test
 */

import { describe, expect, it } from "bun:test"

import {
  isTransientNetworkError,
  TRANSIENT_NETWORK_STREAM_ERROR_TYPE,
  tagTransientNetworkError,
} from "./transient-error.ts"

describe("isTransientNetworkError", () => {
  it("classifies our transport's HTTP/2 connect timeout (the 2026-06-01 hard stop)", () => {
    // The exact string thrown by waitForSession in http2-transport.ts.
    const err = new Error("HTTP/2 connect timeout for https://api.anthropic.com")
    expect(isTransientNetworkError(err)).toBe(true)
  })

  it("classifies the other thrown http2-transport strings", () => {
    expect(
      isTransientNetworkError(
        new Error("HTTP/2 session closed before connect for https://api.anthropic.com"),
      ),
    ).toBe(true)
    expect(
      isTransientNetworkError(
        new Error("HTTP/2 ALPN negotiation failed for https://api.anthropic.com: null"),
      ),
    ).toBe(true)
  })

  it.each([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ERR_HTTP2_GOAWAY_SESSION",
    "UND_ERR_CONNECT_TIMEOUT",
    "ERR_SOCKET_CONNECTION_TIMEOUT",
  ])("classifies code=%s anywhere in the cause chain", (code) => {
    const err = Object.assign(new Error("request failed"), { code })
    expect(isTransientNetworkError(err)).toBe(true)
  })

  it("walks the cause chain (Bun/undici wrap the real errno under `fetch failed`)", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
    const err = Object.assign(new TypeError("fetch failed"), { cause })
    expect(isTransientNetworkError(err)).toBe(true)
  })

  it("classifies common phrasings without a code", () => {
    expect(isTransientNetworkError(new Error("socket hang up"))).toBe(true)
    expect(isTransientNetworkError(new Error("Client network socket disconnected"))).toBe(true)
    expect(isTransientNetworkError(new Error("other side closed"))).toBe(true)
  })

  it("does NOT classify a user abort (must propagate as a real cancel)", () => {
    const abort = new DOMException("aborted", "AbortError")
    expect(isTransientNetworkError(abort)).toBe(false)
    const codeAbort = Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" })
    expect(isTransientNetworkError(codeAbort)).toBe(false)
  })

  it("does NOT reclassify an already-tagged stream error", () => {
    // Owned by the stream-error classifier; re-tagging could override an
    // explicit retryable:false verdict.
    const tagged = Object.assign(new Error("out of quota"), {
      streamErrorType: "api_error",
      retryable: false,
    })
    expect(isTransientNetworkError(tagged)).toBe(false)
  })

  it("does NOT classify a genuine programmer bug", () => {
    expect(isTransientNetworkError(new TypeError("x is not a function"))).toBe(false)
    expect(isTransientNetworkError(new Error("assertion failed: blocks.length > 0"))).toBe(false)
  })
})

describe("tagTransientNetworkError", () => {
  it("tags a transient error with network_error in place", () => {
    const err = new Error("HTTP/2 connect timeout for https://api.anthropic.com")
    const out = tagTransientNetworkError(err)
    expect(out).toBe(err) // same object, mutated in place
    expect((out as { streamErrorType?: string }).streamErrorType).toBe(
      TRANSIENT_NETWORK_STREAM_ERROR_TYPE,
    )
  })

  it("leaves a non-transient error untouched (no tag added)", () => {
    const err = new Error("genuine bug")
    const out = tagTransientNetworkError(err) as { streamErrorType?: string }
    expect(out.streamErrorType).toBeUndefined()
  })

  it("leaves a user abort untouched", () => {
    const err = new DOMException("aborted", "AbortError")
    const out = tagTransientNetworkError(err) as { streamErrorType?: string }
    expect(out.streamErrorType).toBeUndefined()
  })
})

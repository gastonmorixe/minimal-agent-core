/**
 * Tests for the provider-neutral retry coordinator.
 *
 * Mirrors the legacy `client.stream-watchdog.test.ts` retry coverage but
 * against a generic attempt factory: first-try success, retry-on-tagged-
 * error with recovery + visible stall marker + `api.retry*` diag, untagged
 * propagation, and signal-abort stopping the loop. `Math.random` is pinned
 * to 0 so the jittered backoff is instant.
 *
 * @module llm/transport/retry.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { StreamedResponse } from "../../client/types.ts"
import { getDiagnosticBus, type LogEvent, resetDiagnosticBus } from "../../diagnostic-bus.ts"

import { withRetry } from "./retry.ts"

function resp(text: string): StreamedResponse {
  return { blocks: [{ type: "text", text }], text, stopReason: "end_turn" }
}

function tagged(type: string): Error {
  return Object.assign(new Error(type), { streamErrorType: type })
}

function collectDiag(): { events: LogEvent[]; dispose: () => void } {
  const events: LogEvent[] = []
  const dispose = getDiagnosticBus().on("*", (e) => {
    events.push(e)
  })
  return { events, dispose }
}

async function drain(
  gen: AsyncGenerator<string, StreamedResponse, undefined>,
): Promise<{ yields: string[]; result: StreamedResponse }> {
  const yields: string[] = []
  let r: IteratorResult<string, StreamedResponse>
  // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
  while (!(r = await gen.next()).done) yields.push(r.value)
  return { yields, result: r.value }
}

describe("withRetry", () => {
  beforeEach(() => resetDiagnosticBus())
  afterEach(() => resetDiagnosticBus())

  it("returns the attempt result on first success with no retry diag", async () => {
    const { events, dispose } = collectDiag()
    let calls = 0
    try {
      const { yields, result } = await drain(
        withRetry(async function* () {
          calls++
          yield "hi"
          return resp("hi")
        }),
      )
      expect(yields).toEqual(["hi"])
      expect(result.text).toBe("hi")
    } finally {
      dispose()
    }
    expect(calls).toBe(1)
    expect(events.some((e) => e.source === "api.retry")).toBe(false)
    expect(events.some((e) => e.source === "api.retry-success")).toBe(false)
  })

  it("retries a tagged stream error, emits the stall marker + retry diag, and recovers", async () => {
    const origRandom = Math.random
    Math.random = () => 0 // backoff → 0ms
    const { events, dispose } = collectDiag()
    let calls = 0
    try {
      const { yields, result } = await drain(
        withRetry(async function* () {
          calls++
          if (calls === 1) {
            yield "partial"
            throw tagged("stream_idle")
          }
          yield "fresh"
          return resp("fresh")
        }),
      )
      const joined = yields.join("")
      expect(joined).toContain("partial")
      expect(joined).toContain("↳ stream stalled — retrying (attempt 2)")
      expect(joined).toContain("fresh")
      expect(joined.indexOf("partial")).toBeLessThan(joined.indexOf("↳"))
      expect(joined.indexOf("↳")).toBeLessThan(joined.indexOf("fresh"))
      expect(result.text).toBe("fresh")
    } finally {
      Math.random = origRandom
      dispose()
    }
    expect(calls).toBe(2)
    const retry = events.find((e) => e.source === "api.retry")
    expect(retry?.structuredData?.["error-type"]).toBe("stream_idle")
    expect(retry?.structuredData?.attempt).toBe(2)
    expect(retry?.structuredData?.curve).toBe("fast")
    const success = events.find((e) => e.source === "api.retry-success")
    expect(success?.structuredData?.retries).toBe(1)
  })

  it("uses the SLOW curve for hard error types (e.g. invalid_request_error)", async () => {
    const origRandom = Math.random
    Math.random = () => 0
    const { events, dispose } = collectDiag()
    let calls = 0
    try {
      await drain(
        withRetry(async function* () {
          calls++
          if (calls === 1) throw tagged("invalid_request_error")
          yield "ok"
          return resp("ok")
        }),
      )
    } finally {
      Math.random = origRandom
      dispose()
    }
    expect(events.find((e) => e.source === "api.retry")?.structuredData?.curve).toBe("slow")
  })

  it("retries rate_limit_error on the SLOW curve and recovers (does not stop the agent)", async () => {
    const origRandom = Math.random
    Math.random = () => 0 // backoff → 0ms so the test runs instantly
    const { events, dispose } = collectDiag()
    let calls = 0
    try {
      const { result } = await drain(
        withRetry(async function* () {
          calls++
          if (calls === 1) throw tagged("rate_limit_error")
          yield "back"
          return resp("back")
        }),
      )
      expect(result.text).toBe("back")
    } finally {
      Math.random = origRandom
      dispose()
    }
    // It recovered rather than propagating the rate-limit error.
    expect(calls).toBe(2)
    const retry = events.find((e) => e.source === "api.retry")
    expect(retry?.structuredData?.["error-type"]).toBe("rate_limit_error")
    expect(retry?.structuredData?.curve).toBe("slow")
    expect(events.some((e) => e.source === "api.retry-success")).toBe(true)
  })

  it("retries an UNTAGGED connection-level failure (the 2026-06-01 connect-timeout hard stop)", async () => {
    // Regression: a bare `HTTP/2 connect timeout` thrown out of the transport
    // carries no streamErrorType, so the loop used to treat it as a genuine
    // bug and stop the agent. It must now be tagged `network_error` and
    // retried on the fast curve.
    const origRandom = Math.random
    Math.random = () => 0 // backoff → 0ms
    const { events, dispose } = collectDiag()
    let calls = 0
    try {
      const { result } = await drain(
        withRetry(async function* () {
          calls++
          if (calls === 1) {
            // No streamErrorType — exactly what http2-transport throws.
            throw new Error("HTTP/2 connect timeout for https://api.anthropic.com")
          }
          yield "back"
          return resp("back")
        }),
      )
      expect(result.text).toBe("back")
    } finally {
      Math.random = origRandom
      dispose()
    }
    expect(calls).toBe(2)
    const retry = events.find((e) => e.source === "api.retry")
    expect(retry?.structuredData?.["error-type"]).toBe("network_error")
    expect(retry?.structuredData?.curve).toBe("fast")
    expect(events.some((e) => e.source === "api.retry-success")).toBe(true)
  })

  it("retries an errno-coded connection failure carried under a cause chain", async () => {
    const origRandom = Math.random
    Math.random = () => 0
    let calls = 0
    try {
      const { result } = await drain(
        withRetry(async function* () {
          calls++
          if (calls === 1) {
            const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
            throw Object.assign(new TypeError("fetch failed"), { cause })
          }
          yield "ok"
          return resp("ok")
        }),
      )
      expect(result.text).toBe("ok")
    } finally {
      Math.random = origRandom
    }
    expect(calls).toBe(2)
  })

  it("propagates an untagged error without retrying", async () => {
    let calls = 0
    let caught = ""
    try {
      await drain(
        withRetry(async function* () {
          calls++
          throw new Error("genuine bug (no streamErrorType)")
        }),
      )
    } catch (e) {
      caught = (e as Error).message
    }
    expect(caught).toContain("genuine bug")
    expect(calls).toBe(1)
  })

  it("propagates a retryable:false error WITHOUT retrying, even when its tag is in a retryable set", async () => {
    // Regression for 2026-05-30 session 50efb996: a terminal billing failure
    // (insufficient_quota) reached the retry loop and spun for an hour. The
    // provider's explicit retryable:false verdict must win over the tag-based
    // classifier — here the error even carries `api_error` (a retryable tag),
    // yet must propagate on the first attempt.
    let calls = 0
    let caught = ""
    try {
      await drain(
        withRetry(async function* () {
          calls++
          throw Object.assign(new Error("out of quota"), {
            streamErrorType: "api_error",
            retryable: false,
          })
          // biome-ignore lint/correctness/useYield: throw-only attempt
          // oxlint-disable-next-line no-unreachable -- yield satisfies the generator type
          yield ""
        }),
      )
    } catch (e) {
      caught = (e as Error).message
    }
    expect(caught).toContain("out of quota")
    expect(calls).toBe(1)
  })

  it("respects signal: an abort during backoff stops the loop", async () => {
    const ac = new AbortController()
    let calls = 0
    let caught: Error | undefined
    try {
      await drain(
        withRetry(
          async function* () {
            calls++
            ac.abort() // abort before the catch's backoff sleep
            throw tagged("overloaded_error")
          },
          { signal: ac.signal },
        ),
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    expect(caught?.name).toBe("AbortError")
    expect(calls).toBe(1) // never spun up a second attempt
  }, 10_000)
})

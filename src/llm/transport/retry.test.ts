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

import { getDiagnosticBus, type LogEvent, resetDiagnosticBus } from "../../bus/diagnostic-bus.ts"

import { withRetry } from "./retry.ts"
import type { StreamedResponse } from "./types.ts"

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

  it("uses the SLOW curve for rate_limit_error", async () => {
    const origRandom = Math.random
    Math.random = () => 0
    const { events, dispose } = collectDiag()
    let calls = 0
    try {
      await drain(
        withRetry(async function* () {
          calls++
          if (calls === 1) throw tagged("rate_limit_error")
          yield "ok"
          return resp("ok")
        }),
      )
    } finally {
      Math.random = origRandom
      dispose()
    }
    const retry = events.find((e) => e.source === "api.retry")
    expect(retry?.structuredData?.["error-type"]).toBe("rate_limit_error")
    expect(retry?.structuredData?.curve).toBe("slow")
  })

  it("gives stream_closed_without_terminal exactly one short pre-effect retry (not slow curve)", async () => {
    const origRandom = Math.random
    Math.random = () => 0 // delay → 0ms
    const { events, dispose } = collectDiag()
    let calls = 0
    try {
      const { result } = await drain(
        withRetry(async function* () {
          calls++
          if (calls === 1) {
            throw Object.assign(new Error("truncated"), {
              streamErrorType: "stream_closed_without_terminal",
              attemptProgress: { sawReasoning: false, sawText: false, completedToolCalls: 0 },
            })
          }
          yield "ok"
          return resp("ok")
        }),
      )
      expect(result.text).toBe("ok")
    } finally {
      Math.random = origRandom
      dispose()
    }
    expect(calls).toBe(2)
    const retry = events.find((e) => e.source === "api.retry")
    expect(retry?.structuredData?.["error-type"]).toBe("stream_closed_without_terminal")
    expect(retry?.structuredData?.curve).toBe("terminal-less-bounded")
    expect(retry?.structuredData?.curve).not.toBe("slow")
  })

  it("does not invoke makeAttempt again after terminal-less close with completed tools", async () => {
    const origRandom = Math.random
    Math.random = () => 0
    const { events, dispose } = collectDiag()
    let calls = 0
    let caught: Error | undefined
    try {
      await drain(
        withRetry(async function* () {
          calls++
          throw Object.assign(new Error("truncated after tools"), {
            streamErrorType: "stream_closed_without_terminal",
            attemptProgress: {
              sawReasoning: true,
              sawText: false,
              completedToolCalls: 1,
              lastEventType: "stream_error",
            },
          })
          // biome-ignore lint/correctness/useYield: throw-only attempt
          // oxlint-disable-next-line no-unreachable
          yield ""
        }),
      )
    } catch (e) {
      caught = e as Error
    } finally {
      Math.random = origRandom
      dispose()
    }
    expect(calls).toBe(1)
    expect(caught?.message).toContain("truncated after tools")
    expect(events.some((e) => e.source === "api.retry")).toBe(false)
    expect(events.some((e) => e.source === "api.retry-terminal-less-stop")).toBe(true)
  })

  it("stops after one failed pre-effect terminal-less retry (no unlimited loop)", async () => {
    const origRandom = Math.random
    Math.random = () => 0
    let calls = 0
    let caught: Error | undefined
    try {
      await drain(
        withRetry(async function* () {
          calls++
          throw Object.assign(new Error(`termless ${calls}`), {
            streamErrorType: "stream_closed_without_terminal",
            attemptProgress: { sawReasoning: true, sawText: false, completedToolCalls: 0 },
          })
          // biome-ignore lint/correctness/useYield: throw-only attempt
          // oxlint-disable-next-line no-unreachable
          yield ""
        }),
      )
    } catch (e) {
      caught = e as Error
    } finally {
      Math.random = origRandom
    }
    // First throw → one retry → second throw fails the turn. Never loops forever.
    expect(calls).toBe(2)
    expect(caught?.message).toContain("termless")
  })

  it("does not treat text-only terminal-less close as rate-limit slow curve", async () => {
    const origRandom = Math.random
    Math.random = () => 0
    const { events, dispose } = collectDiag()
    let calls = 0
    try {
      await drain(
        withRetry(async function* () {
          calls++
          if (calls === 1) {
            yield "partial text"
            throw Object.assign(new Error("truncated after text"), {
              streamErrorType: "stream_closed_without_terminal",
              attemptProgress: { sawReasoning: false, sawText: true, completedToolCalls: 0 },
            })
          }
          yield " recovered"
          return resp("partial text recovered")
        }),
      )
    } finally {
      Math.random = origRandom
      dispose()
    }
    expect(calls).toBe(2)
    const retry = events.find((e) => e.source === "api.retry")
    expect(retry?.structuredData?.curve).toBe("terminal-less-bounded")
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

  it("propagates not_found_error without retrying", async () => {
    const { events, dispose } = collectDiag()
    let calls = 0
    let caught = ""
    try {
      await drain(
        withRetry(async function* () {
          calls++
          throw tagged("not_found_error")
          // biome-ignore lint/correctness/useYield: throw-only attempt
          // oxlint-disable-next-line no-unreachable -- yield satisfies the generator type
          yield ""
        }),
      )
    } catch (e) {
      caught = (e as Error).message
    } finally {
      dispose()
    }

    expect(caught).toContain("not_found_error")
    expect(calls).toBe(1)
    expect(events.some((e) => e.source === "api.retry")).toBe(false)
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
            throw new Error("HTTP/2 connect timeout for https://api.example.com")
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

  it("propagates stream_truncated WITHOUT retrying (model refusal must never freeze the agent)", async () => {
    // Regression for session 81adb696 (2026-06-19): a model refusal
    // (output "Blocked") with no finish_reason caused the server to close
    // the SSE stream without message_stop. The watchdog threw
    // `stream_truncated`, which was classified as retryable, causing
    // the agent to retry FOREVER with no cap — the session froze for
    // 7+ minutes until killed externally.
    //
    // `stream_truncated` is NOT a transient network failure: the server
    // made an intentional decision (content filter, refusal, early stop)
    // and retrying with the same prompt will produce the same result.
    // The error must propagate so the agent surfaces whatever partial
    // text was produced and moves on.
    let calls = 0
    let caught: Error | undefined
    const yields: string[] = []
    try {
      const gen = withRetry(async function* () {
        calls++
        if (calls === 1) {
          yield "Block"
          yield "ed"
          throw tagged("stream_truncated")
        }
        // Should never reach here
        yield "should-not-exist"
        return resp("should-not-exist")
      })
      let r: IteratorResult<string, StreamedResponse>
      // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
      while (!(r = await gen.next()).done) yields.push(r.value)
    } catch (e) {
      caught = e as Error
    }

    // The error propagated rather than being retried forever.
    expect(caught).toBeDefined()
    expect(caught?.message).toContain("stream_truncated")
    expect(calls).toBe(1) // never retried

    // The partial text that was yielded BEFORE the truncation is preserved.
    expect(yields.join("")).toBe("Blocked")
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

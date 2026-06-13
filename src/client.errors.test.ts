import { describe, expect, it } from "bun:test"

import type { AuthResult } from "./auth.ts"
import { fakeNetworkClient, sseResponse } from "./client.fixtures.ts"
import { type Message, sendMessage, sendMessageOnce } from "./client.ts"
import { getDiagnosticBus, isErrorDiagEmitted, type LogEvent, Severity } from "./diagnostic-bus.ts"
import { NetworkClient, NetworkResponse, type NetworkTransport } from "./network/index.ts"

describe("client", () => {
  // -------------------------------------------------------------------------
  // SSE error event handling (regression: Anthropic returns mid-stream
  // errors over HTTP 200 as `event: error` SSE frames. Before
  // `client.ts:case "error":` existed, the event fell through the switch
  // silently — sendMessage returned { blocks: [], text: "" } and the
  // agent loop treated it as a natural empty turn: no scrollback, no
  // warning, no retry. See docs/changes or the .net-dbg captures of
  // session d5e415fb-… for the wire shape.)
  //
  // These tests exercise `sendMessageOnce` (the single-attempt internal)
  // directly so we observe the bare throw + diag.error contract without
  // the retry coordinator firing. Retry behavior has its own block below.
  // -------------------------------------------------------------------------
  describe("SSE error event handling", () => {
    /**
     * Subscribe to the singleton diagnostic bus for the duration of a
     * single test. Returns the captured events and an explicit
     * `dispose()` for the test's try/finally.
     */
    function captureDiagEvents(): {
      events: LogEvent[]
      dispose: () => void
    } {
      const events: LogEvent[] = []
      const dispose = getDiagnosticBus().on("*", (e) => events.push(e))
      return { events, dispose }
    }

    /** Drain a generator to completion; collect yields, return final. */
    async function drain(
      gen: AsyncGenerator<string, unknown, undefined>,
    ): Promise<{ yields: string[]; final: unknown }> {
      const yields: string[] = []
      let result: IteratorResult<string, unknown>
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic drain
      while (!(result = await gen.next()).done) {
        yields.push(result.value)
      }
      return { yields, final: result.value }
    }

    it("throws on `event: error` with overloaded_error and surfaces via diag.error", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      // Single SSE frame: the same shape Anthropic emits for transient
      // capacity issues (200 OK + `event: error` body). Our parseSSE
      // ignores the `event:` line and only inspects `data:`, so passing
      // just the JSON payload through sseResponse(...) reproduces the
      // exact wire condition the agent saw on 2026-05-20T14:56:51.
      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
            request_id: "req_test_overload_001",
          },
        ]),
      )

      const cap = captureDiagEvents()
      let caught: unknown = null
      try {
        await drain(
          sendMessageOnce({
            auth,
            messages,
            model: "claude-opus-4-7",
            stream: true,
            networkClient,
          }),
        )
      } catch (err) {
        caught = err
      } finally {
        cap.dispose()
      }

      // Throw shape: identifiable message AND tagged for the agent's
      // bare-fallback-line gate (`isErrorDiagEmitted`).
      expect(caught).toBeInstanceOf(Error)
      const err = caught as Error & { streamErrorType?: string }
      expect(err.message).toContain("Anthropic stream error")
      expect(err.message).toContain("overloaded_error")
      expect(err.message).toContain("Overloaded")
      expect(isErrorDiagEmitted(err)).toBe(true)
      // Stage B tag: structured marker for the retry classifier
      expect(err.streamErrorType).toBe("overloaded_error")

      // Diag emission: exactly one Error-severity event with the
      // structured payload sinks subscribe to (file log, scrollback,
      // TUI footer all key on this).
      const diagErrors = cap.events.filter(
        (e) => e.severity === Severity.Error && e.source === "api.stream-error",
      )
      expect(diagErrors).toHaveLength(1)
      const e = diagErrors[0]
      expect(e.message).toContain("overloaded_error: Overloaded")
      expect(e.structuredData).toBeDefined()
      expect(e.structuredData!["error-type"]).toBe("overloaded_error")
      expect(e.structuredData!["request-id"]).toBe("req_test_overload_001")
    })

    it("also surfaces other error types (api_error, invalid_request_error, …)", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          {
            type: "error",
            error: { type: "api_error", message: "Internal server error" },
            request_id: "req_test_api_002",
          },
        ]),
      )

      const cap = captureDiagEvents()
      let caught: unknown = null
      try {
        await drain(
          sendMessageOnce({
            auth,
            messages,
            model: "claude-opus-4-7",
            stream: true,
            networkClient,
          }),
        )
      } catch (err) {
        caught = err
      } finally {
        cap.dispose()
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain("api_error")
      const diagErrors = cap.events.filter(
        (e) => e.severity === Severity.Error && e.source === "api.stream-error",
      )
      expect(diagErrors).toHaveLength(1)
      expect(diagErrors[0].structuredData!["error-type"]).toBe("api_error")
    })

    it("missing error fields fall back to `unknown_error` / `stream error`", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      // Defensive: a malformed/partial SSE error frame missing the
      // nested error object. We still surface, still throw, still tag.
      const networkClient = fakeNetworkClient(() => sseResponse([{ type: "error" }]))

      const cap = captureDiagEvents()
      let caught: unknown = null
      try {
        await drain(
          sendMessageOnce({
            auth,
            messages,
            model: "claude-opus-4-7",
            stream: true,
            networkClient,
          }),
        )
      } catch (err) {
        caught = err
      } finally {
        cap.dispose()
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain("unknown_error")
      expect((caught as Error).message).toContain("stream error")
      expect(isErrorDiagEmitted(caught as Error)).toBe(true)
      // request-id key is omitted when the server didn't send one
      const e = cap.events.find(
        (x) => x.severity === Severity.Error && x.source === "api.stream-error",
      )!
      expect(e.structuredData).toBeDefined()
      expect(e.structuredData!["error-type"]).toBe("unknown_error")
      expect(e.structuredData!["request-id"]).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Stage B: sendMessage retry coordinator (around sendMessageOnce)
  // -------------------------------------------------------------------------
  describe("sendMessage retry coordinator", () => {
    /** Subscribe to the singleton bus for one test. */
    function captureDiagEvents(): {
      events: LogEvent[]
      dispose: () => void
    } {
      const events: LogEvent[] = []
      const dispose = getDiagnosticBus().on("*", (e) => events.push(e))
      return { events, dispose }
    }

    async function drain(
      gen: AsyncGenerator<string, unknown, undefined>,
    ): Promise<{ yields: string[]; final: unknown }> {
      const yields: string[] = []
      let result: IteratorResult<string, unknown>
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic drain
      while (!(result = await gen.next()).done) {
        yields.push(result.value)
      }
      return { yields, final: result.value }
    }

    /**
     * Build a networkClient whose `request` returns the n-th value from
     * `responses` (in order, looping the LAST entry if drained). Records
     * the call count so tests can assert "retried K times then succeeded".
     */
    function scriptedNetworkClient(responses: NetworkResponse[]): {
      client: NetworkClient
      calls: number
    } {
      const state = { calls: 0 }
      const client = fakeNetworkClient(() => {
        const i = Math.min(state.calls, responses.length - 1)
        state.calls += 1
        return responses[i]
      })
      // The returned object's `calls` field is a live count via closure.
      // Use a getter so callers see the up-to-date value.
      return {
        client,
        get calls() {
          return state.calls
        },
      } as { client: NetworkClient; calls: number }
    }

    it("retries overloaded_error then succeeds on the 3rd attempt (no error surfaces to caller)", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      // Two overload responses, then a successful stream that yields "OK".
      const scripted = scriptedNetworkClient([
        sseResponse([
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
            request_id: "req_retry_1",
          },
        ]),
        sseResponse([
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
            request_id: "req_retry_2",
          },
        ]),
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "OK" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ]),
      ])

      const cap = captureDiagEvents()
      let drained: { yields: string[]; final: unknown }
      try {
        drained = await drain(
          sendMessage({
            auth,
            messages,
            model: "claude-opus-4-7",
            stream: true,
            networkClient: scripted.client,
          }),
        )
      } finally {
        cap.dispose()
      }

      // Three POST attempts, final yields the success text
      expect(scripted.calls).toBe(3)
      expect(drained.yields.join("")).toContain("OK")
      // The first two attempts emit retry diagnostics (warn-severity)
      const retryWarns = cap.events.filter(
        (e) => e.severity === Severity.Warning && e.source === "api.retry",
      )
      expect(retryWarns.length).toBe(2)
      for (const w of retryWarns) {
        expect(w.structuredData!["error-type"]).toBe("overloaded_error")
        // Under the new retry-forever policy we no longer emit a
        // "max-attempts" field (there's no max). The structured data
        // carries the attempt number + elapsed-ms instead.
        expect(typeof w.structuredData!["attempt"]).toBe("number")
        expect(typeof w.structuredData!["elapsed-ms"]).toBe("number")
      }
      // And the two failed attempts each fire diag.error("api.stream-error")
      const streamErrors = cap.events.filter(
        (e) => e.severity === Severity.Error && e.source === "api.stream-error",
      )
      expect(streamErrors.length).toBe(2)
    }, 20_000) // generous: jittered sleeps can add up to ~4s for 2 retries

    it("retries EVEN AFTER yielding mid-stream (with a visible ↳ marker in the stream)", async () => {
      // Harness principle: the agent loop must run forever. Earlier
      // behavior gave up if content had already reached the UI to avoid
      // "duplicated output". The new contract: we retry anyway and
      // PAINT A MARKER (`↳ stream stalled — retrying (attempt N)…`)
      // into the yielded text so the user sees where attempt N ended
      // and attempt N+1 begins. Duplication is honest and visible; the
      // alternative — giving up — leaves the harness stuck.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      const scripted = scriptedNetworkClient([
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial..." },
          },
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          },
        ]),
        // Second response succeeds — we expect to reach it now.
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "recovered." },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
        ]),
      ])

      // Force backoff to 0 so the test finishes fast.
      const originalRandom = Math.random
      Math.random = () => 0
      const yields: string[] = []
      try {
        const gen = sendMessage({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient: scripted.client,
        })
        for await (const chunk of gen) yields.push(chunk)
      } finally {
        Math.random = originalRandom
      }

      const joined = yields.join("")
      expect(joined).toContain("partial...")
      expect(joined).toContain("↳ stream stalled — retrying")
      expect(joined).toContain("recovered.")
      expect(joined.indexOf("partial")).toBeLessThan(joined.indexOf("↳"))
      expect(joined.indexOf("↳")).toBeLessThan(joined.indexOf("recovered"))
      expect(scripted.calls).toBe(2)
    }, 15_000)

    it("invalid_request_error uses slow-curve retry (still retries — harness never gives up)", async () => {
      // Harness principle (revised 2026-05-26): the agent loop NEVER
      // gives up on a tagged stream error. Validation errors used to
      // fail-fast, but a misconfigured request might be fixable
      // out-of-band (a human edits a config while the harness waits),
      // so the new policy is "everything retries, with different
      // backoff curves". invalid_request_error gets the slow curve
      // (RETRY_SLOW_BASE_DELAY_MS = 30_000) so we don't spam.
      //
      // This test verifies: when invalid_request_error fires once and
      // the next attempt succeeds, the harness made it through. We
      // force Math.random()→0 so the slow backoff is effectively zero
      // (the random factor multiplies the base, not adds to it).
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      const scripted = scriptedNetworkClient([
        sseResponse([
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "messages.0.content[0].text is required",
            },
          },
        ]),
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
        ]),
      ])

      const originalRandom = Math.random
      Math.random = () => 0
      try {
        const yields: string[] = []
        const gen = sendMessage({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient: scripted.client,
        })
        for await (const chunk of gen) yields.push(chunk)
        expect(yields.join("")).toContain("ok")
      } finally {
        Math.random = originalRandom
      }

      // Both attempts ran — the slow-curve retry kicked in.
      expect(scripted.calls).toBe(2)
    }, 15_000)

    it("rate_limit_error retries on the slow curve and recovers (does NOT stop the agent)", async () => {
      // Regression for 2026-05-30: a `rate_limit_error` SSE error frame
      // (HTTP 200, `event: error`, "Rate limited") matched NEITHER the
      // fast nor the slow retry set, so it propagated and stopped the
      // agent mid-task. The fix puts rate_limit_error on the SLOW curve so
      // the harness waits the limit window out and recovers automatically.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      const scripted = scriptedNetworkClient([
        sseResponse([
          {
            type: "error",
            error: { type: "rate_limit_error", message: "Rate limited" },
            request_id: "req_test_ratelimit_001",
          },
        ]),
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "recovered" },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
        ]),
      ])

      const cap = captureDiagEvents()
      const originalRandom = Math.random
      Math.random = () => 0 // collapse the slow backoff to ~0ms
      try {
        const yields: string[] = []
        const gen = sendMessage({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient: scripted.client,
        })
        for await (const chunk of gen) yields.push(chunk)
        expect(yields.join("")).toContain("recovered")
      } finally {
        Math.random = originalRandom
        cap.dispose()
      }

      // Both attempts ran — it retried instead of throwing.
      expect(scripted.calls).toBe(2)
      const retryWarn = cap.events.find(
        (e) => e.severity === Severity.Warning && e.source === "api.retry",
      )
      expect(retryWarn?.structuredData?.["error-type"]).toBe("rate_limit_error")
      expect(retryWarn?.structuredData?.curve).toBe("slow")
    }, 15_000)

    it("pre-stream HTTP 429 is tagged rate_limit_error and retries (does NOT stop the agent)", async () => {
      // A rate limit can also arrive as a non-2xx HTTP status BEFORE the
      // SSE stream opens (no `event: error` frame). That path used to
      // throw an untagged `API 429: …` error → no retry → agent stops.
      // The fix maps the status to the same tag so it retries on the slow
      // curve like its in-stream twin.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      const rateLimited = new NetworkResponse({
        status: 429,
        headers: { "content-type": "application/json" },
        transport: { id: "fake", protocol: "h2" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  type: "error",
                  error: { type: "rate_limit_error", message: "Rate limited" },
                }),
              ),
            )
            controller.close()
          },
        }),
      })
      const scripted = scriptedNetworkClient([
        rateLimited,
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "after-limit" },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
        ]),
      ])

      const cap = captureDiagEvents()
      const originalRandom = Math.random
      Math.random = () => 0
      try {
        const yields: string[] = []
        const gen = sendMessage({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient: scripted.client,
        })
        for await (const chunk of gen) yields.push(chunk)
        expect(yields.join("")).toContain("after-limit")
      } finally {
        Math.random = originalRandom
        cap.dispose()
      }

      expect(scripted.calls).toBe(2)
      const retryWarn = cap.events.find(
        (e) => e.severity === Severity.Warning && e.source === "api.retry",
      )
      expect(retryWarn?.structuredData?.["error-type"]).toBe("rate_limit_error")
      expect(retryWarn?.structuredData?.curve).toBe("slow")
    }, 15_000)

    it("untagged errors (programmer bugs, kernel-level failures) DO propagate to caller", async () => {
      // The retry-forever policy applies only to TAGGED stream errors
      // (anything with streamErrorType set). Genuinely untagged
      // throws — transport explosions, kernel-level failures, OOM —
      // still propagate so the operator notices something is wrong.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      const transport: NetworkTransport = {
        id: "broken",
        request: async () => {
          throw new Error("transport blew up (no streamErrorType)")
        },
      }
      const client = new NetworkClient({ primary: transport })

      let caught: unknown = null
      try {
        await drain(
          sendMessage({
            auth,
            messages,
            model: "claude-opus-4-7",
            stream: true,
            networkClient: client,
          }),
        )
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain("transport blew up")
    }, 5_000)
  })
})

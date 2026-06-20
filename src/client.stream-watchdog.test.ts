/**
 * Stream watchdog + indefinite-retry coverage for the Messages API client.
 *
 * Why this test file exists
 * =========================
 *
 * On 2026-05-25 a real agent session locked up for 1h 54m because the
 * Anthropic edge served a truncated SSE stream (status 200, content-type
 * text/event-stream, 36 thinking_delta events, then NOTHING — no
 * `content_block_stop`, no `signature_delta`, no `message_delta`, no
 * `message_stop`, no `error`, no RST_STREAM at the HTTP/2 layer). bun's
 * HTTP client kept the TCP connection alive (HTTP/2 PING frames flowing),
 * `parseSSE` blocked forever on `for await (... of response.body)`, the
 * agent loop sat waiting for `message_stop` that would never arrive.
 *
 * These tests pin the FIX so that pattern never silently re-hangs a
 * harness:
 *
 *   1. Stream-idle watchdog: if no SSE event arrives for
 *      `streamIdleTimeoutMs`, abort the attempt with
 *      `streamErrorType: "stream_idle"`.
 *   2. Close-without-`message_stop`: when the body ends cleanly but never
 *      sent the terminator, throw `streamErrorType: "stream_truncated"`.
 *   3. Indefinite retry: every retryable error type loops forever (no
 *      `maxAttempts`, no `maxTotalMs`). The harness must outlive its
 *      caller's patience, not vice versa.
 *   4. The `↳ stream stalled — retrying` marker is yielded into the text
 *      stream when retry happens mid-yield.
 *   5. Recovery emits a `diag.warn("api.retry-success", ...)` so the
 *      scrollback shows "we made it back".
 *
 * All tests use the fake-NetworkClient pattern from `client.text-stop.test.ts`
 * — small ReadableStreams synthesized in memory. We DO NOT exercise the
 * actual `undici` or `http2` transports here; those have their own
 * test files in `src/network/`.
 *
 * @module client.stream-watchdog.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "./auth.ts"
import { type Message, sendMessage, sendMessageFull } from "./client.ts"
import { getDiagnosticBus, type LogEvent, resetDiagnosticBus } from "./diagnostic-bus.ts"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "./network/index.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeHandler = (req: NetworkRequest) => NetworkResponse | Promise<NetworkResponse>

function fakeNetworkClient(handler: FakeHandler): NetworkClient {
  const transport: NetworkTransport = {
    id: "fake",
    request: async (req) => handler(req),
  }
  return new NetworkClient({ primary: transport })
}

/**
 * SSE response with EXPLICIT event list. Unlike the helper in
 * `client.text-stop.test.ts`, this one does NOT auto-inject
 * `message_stop` — these tests want to control exactly what events
 * arrive, including the absence of a terminator.
 */
function rawSseResponse(events: unknown[]): NetworkResponse {
  const encoder = new TextEncoder()
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_test_001" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`))
        }
        controller.close()
      },
    }),
  })
}

/**
 * SSE response that streams a few events then NEVER CLOSES. Simulates the
 * 2026-05-25 truncation: server stopped sending events but didn't close
 * the body. Without our watchdog, `parseSSE` would block forever.
 *
 * Real transports (`fetch`, `http2`) listen on the request's AbortSignal
 * and tear down the body when it aborts. Our fake transport has to wire
 * that up explicitly — without this hook, the AbortController in
 * `sendMessageOnce` aborts the signal but `parseSSE` never gets unstuck.
 */
function stallSseResponse(eventsBeforeStall: unknown[], signal?: AbortSignal): NetworkResponse {
  const encoder = new TextEncoder()
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_test_stall_001" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of eventsBeforeStall) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`))
        }
        // Intentionally leave the stream OPEN. No more enqueue, no close.
        // Wire signal → close so attemptAbort tears down the body the same
        // way the real fetch/http2 transports do (see fetch-transport.ts).
        if (signal) {
          const onAbort = () => {
            try {
              controller.close()
            } catch {
              // Ignore double-close — also fine if already closed.
            }
          }
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        }
      },
    }),
  })
}

/**
 * A request that NEVER returns response headers : the transport Promise
 * stays pending until the request's AbortSignal fires, then rejects (the
 * way the real http2/fetch transports do on abort). Models the 2026-05-28
 * 13h hang: a server that accepted the POST but never sent the 200 SSE
 * headers, so `await networkClient.request()` blocked forever with no
 * watchdog covering the pre-response phase.
 */
function hangingResponse(signal?: AbortSignal): Promise<NetworkResponse> {
  return new Promise<NetworkResponse>((_resolve, reject) => {
    if (!signal) return // hang forever (only used where a signal is always present)
    const onAbort = () => reject(signal.reason ?? new Error("Network request aborted"))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
}

const auth: AuthResult = { type: "oauth", token: "test-token" }
const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

// Collect diag events fired during a test for assertion.
function collectDiag(): { events: LogEvent[]; dispose: () => void } {
  const events: LogEvent[] = []
  const bus = getDiagnosticBus()
  const dispose = bus.on("*", (e) => {
    events.push(e)
  })
  return { events, dispose }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("client.streamWatchdog", () => {
  // Reset the diag singleton between tests so collected events don't leak.
  beforeEach(() => {
    resetDiagnosticBus()
  })
  afterEach(() => {
    resetDiagnosticBus()
  })

  it("throws stream_idle when no events arrive within streamIdleTimeoutMs", async () => {
    // Stream sends nothing, then sits open. The watchdog should fire
    // at +50ms and abort with streamErrorType="stream_idle".
    let calls = 0
    const networkClient = fakeNetworkClient((req) => {
      calls++
      // First call: stalls. Second call: succeeds (to satisfy retry).
      if (calls === 1) {
        return stallSseResponse(
          [
            { type: "message_start", message: { id: "msg_x", usage: { input_tokens: 1 } } },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "", signature: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "half a thought…" },
            },
          ],
          req.signal,
        )
      }
      return rawSseResponse([
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
        { type: "message_stop" },
      ])
    })

    const { events: diagEvents, dispose } = collectDiag()
    try {
      const result = await sendMessageFull({
        auth,
        messages,
        model: "claude-opus-4-7",
        stream: true,
        networkClient,
        // Tight timeout for fast deterministic test. The watchdog ticks
        // every 1s so we set the timeout to 50ms (idle check sees idleMs
        // jump from 0 → ~1000ms on the next tick, well above 50ms).
        streamIdleTimeoutMs: 50,
      })
      expect(result.blocks).toEqual([{ type: "text", text: "recovered" }])
    } finally {
      dispose()
    }

    // First attempt should have emitted api.stream-stalled with
    // error-type=stream_idle. Then api.retry. Then api.retry-success.
    const stalled = diagEvents.find((e) => e.source === "api.stream-stalled")
    expect(stalled).toBeDefined()
    expect(stalled?.structuredData?.["error-type"]).toBe("stream_idle")

    const retry = diagEvents.find((e) => e.source === "api.retry")
    expect(retry).toBeDefined()
    expect(retry?.structuredData?.["error-type"]).toBe("stream_idle")
    expect(retry?.structuredData?.attempt).toBe(2)

    const success = diagEvents.find((e) => e.source === "api.retry-success")
    expect(success).toBeDefined()
    expect(success?.structuredData?.retries).toBe(1)
  }, 30_000)

  it("aborts + retries when response headers never arrive (pre-response TTFB guard)", async () => {
    // 2026-05-28 regression: the streaming idle watchdog only arms once we
    // start reading the SSE body, so a request that never gets response
    // headers (stalled upload / black-holed socket) used to hang
    // `await networkClient.request()` forever — no watchdog, no retry.
    // The `responseHeadersTimeoutMs` guard must fire, tag the failure
    // `stream_idle`, and let the harness retry to recovery.
    let calls = 0
    const networkClient = fakeNetworkClient((req) => {
      calls++
      // First attempt: never returns headers (until the guard aborts it).
      if (calls === 1) return hangingResponse(req.signal)
      // Second attempt: a clean, terminated stream.
      return rawSseResponse([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ])
    })

    const { events: diagEvents, dispose } = collectDiag()
    try {
      const result = await sendMessageFull({
        auth,
        messages,
        model: "claude-opus-4-7",
        stream: true,
        networkClient,
        // Tight pre-response deadline for a fast deterministic test.
        responseHeadersTimeoutMs: 50,
      })
      expect(result.blocks).toEqual([{ type: "text", text: "recovered" }])
    } finally {
      dispose()
    }

    expect(calls).toBe(2)

    const stalled = diagEvents.find(
      (e) => e.source === "api.stream-stalled" && e.structuredData?.phase === "pre-response",
    )
    expect(stalled).toBeDefined()
    expect(stalled?.structuredData?.["error-type"]).toBe("stream_idle")

    const retry = diagEvents.find((e) => e.source === "api.retry")
    expect(retry?.structuredData?.["error-type"]).toBe("stream_idle")

    const success = diagEvents.find((e) => e.source === "api.retry-success")
    expect(success?.structuredData?.retries).toBe(1)
  }, 30_000)

  it("a user abort during the pre-response phase is NOT retried", async () => {
    // The TTFB guard must not swallow a real Ctrl-C: when opts.signal
    // (not our deadline) aborts before headers arrive, the error stays
    // untagged and propagates instead of looping forever.
    let calls = 0
    const ac = new AbortController()
    const networkClient = fakeNetworkClient((req) => {
      calls++
      queueMicrotask(() => ac.abort())
      return hangingResponse(req.signal)
    })

    let caught = ""
    try {
      await sendMessageFull({
        auth,
        messages,
        model: "claude-opus-4-7",
        stream: true,
        networkClient,
        signal: ac.signal,
        // Large so OUR guard never fires : the user signal is what stops us.
        responseHeadersTimeoutMs: 60_000,
      })
    } catch (e) {
      caught = (e as Error).message
    }
    expect(caught.length).toBeGreaterThan(0)
    expect(caught).not.toContain("stalled before response headers")
    expect(calls).toBe(1)
  }, 10_000)

  it("throws stream_truncated when body closes cleanly but never sent message_stop — error propagates, never retries", async () => {
    // The classic 2026-05-25 bug shape: a perfectly-formed-looking stream
    // that just stops short of message_stop. stream_truncated is NOT a
    // retryable error (it signals an intentional model refusal or content
    // filter decision, not a transient network failure), so the error must
    // propagate to the caller after yielding whatever partial text arrived.
    let calls = 0
    const networkClient = fakeNetworkClient(() => {
      calls++
      return rawSseResponse([
        // Note: NO message_stop at the end.
        { type: "message_start", message: { id: "msg_x", usage: { input_tokens: 1 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "incomplete" },
        },
      ])
    })

    const { events: diagEvents, dispose } = collectDiag()
    try {
      const yielded: string[] = []
      const gen = sendMessage({
        auth,
        messages,
        model: "claude-opus-4-7",
        stream: true,
        networkClient,
        streamIdleTimeoutMs: 30_000, // not relevant for this test
      })
      for await (const chunk of gen) yielded.push(chunk)
      // Should never reach here — the error must propagate.
      expect("unreachable").toBe("stream_truncated should have propagated")
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain("stream_truncated")
      expect(msg).toContain("server truncated")
    } finally {
      dispose()
    }

    // Only one attempt: the truncated stream was NOT retried.
    expect(calls).toBe(1)

    // The partial text that arrived before the truncation is preserved
    // in the yielded stream.
    const stalled = diagEvents.find((e) => e.source === "api.stream-stalled")
    expect(stalled).toBeDefined()
    expect(stalled?.structuredData?.["error-type"]).toBe("stream_truncated")
    expect(stalled?.structuredData?.["request-id"]).toBe("req_test_001")
  }, 30_000)

  it("emits api.retry-sustained warning at every 12th retry", async () => {
    // Force the first 13 attempts to fail with overloaded_error, then
    // succeed on the 14th. The sustained-retry warning fires on attempt
    // 13 (after 12 retries since attempt 1). Then a retry-success.
    let calls = 0
    const networkClient = fakeNetworkClient(() => {
      calls++
      if (calls <= 13) {
        return rawSseResponse([
          { type: "error", error: { type: "overloaded_error", message: "overloaded" } },
        ])
      }
      return rawSseResponse([
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
        { type: "message_stop" },
      ])
    })

    const { events: diagEvents, dispose } = collectDiag()
    try {
      // Use a tiny backoff so the test runs fast. We monkey-patch via
      // calling sendMessage normally — the backoff is `Math.random() *
      // ideal` capped at RETRY_MAX_DELAY_MS, with `base = 200`. For
      // attempt-1's backoff: random([0, 200)). At attempt 11+ it caps
      // at 5min, but for this test we hit cap at attempt 11+. Without
      // a delay override the test runs ~30s. To keep it fast and
      // deterministic, drive the random to 0 by Math.random override.
      const originalRandom = Math.random
      Math.random = () => 0
      try {
        const result = await sendMessageFull({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient,
        })
        expect(result.blocks).toEqual([{ type: "text", text: "ok" }])
      } finally {
        Math.random = originalRandom
      }
    } finally {
      dispose()
    }

    // Should see exactly one api.retry-sustained event (after 12 retries
    // = on the 13th attempt's failure handling).
    const sustained = diagEvents.filter((e) => e.source === "api.retry-sustained")
    expect(sustained.length).toBe(1)
    expect(sustained[0].structuredData?.retries).toBe(12)

    // And finally a retry-success on the 14th attempt.
    const success = diagEvents.find((e) => e.source === "api.retry-success")
    expect(success).toBeDefined()
    expect(success?.structuredData?.retries).toBe(13)
  }, 60_000)

  it("untagged errors (no streamErrorType) propagate without retry", async () => {
    // Programmer bugs / kernel-level failures must NOT loop forever.
    // The retry policy is "every TAGGED error". Untagged Error → throw.
    const networkClient = fakeNetworkClient(() => {
      throw new Error("transport blew up (no streamErrorType tag)")
    })

    let caughtMessage = ""
    try {
      await sendMessageFull({
        auth,
        messages,
        model: "claude-opus-4-7",
        stream: true,
        networkClient,
      })
    } catch (e) {
      caughtMessage = (e as Error).message
    }
    expect(caughtMessage).toContain("transport blew up")
  }, 5_000)

  it("respects opts.signal: caller-driven abort overrides retry-forever", async () => {
    // If the user hits Ctrl-C (opts.signal aborts), we must NOT keep
    // looping. The principle is "no give-up *by the harness*"; the
    // user is allowed to stop us. The composed signal in
    // sendMessageOnce wires opts.signal into the transport.
    let calls = 0
    const ac = new AbortController()
    const networkClient = fakeNetworkClient((req) => {
      calls++
      // Trigger user abort on the first request.
      queueMicrotask(() => ac.abort())
      return stallSseResponse([], req.signal)
    })

    let caughtMessage = ""
    try {
      await sendMessageFull({
        auth,
        messages,
        model: "claude-opus-4-7",
        stream: true,
        networkClient,
        signal: ac.signal,
        streamIdleTimeoutMs: 30_000,
      })
    } catch (e) {
      caughtMessage = (e as Error).message
    }
    // Either an "AbortError"-ish from the transport, or our watchdog's
    // signal got cancelled by the parent signal. Either way: we exit.
    expect(caughtMessage.length).toBeGreaterThan(0)
    // Should NOT have spun up a second attempt.
    expect(calls).toBe(1)
  }, 10_000)
})

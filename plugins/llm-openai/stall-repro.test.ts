/**
 * REPRODUCTION of the gpt-5.5 resume stall (session 7919d877, resume of
 * ac367efe). Built from the REAL captured wire bytes (net-dbg attempt 024) and
 * cross-checked against the REAL session log
 * (~/.minimal-agent/logs/ma-session-7919d877-*.log).
 *
 * Runs the REAL production pipeline end to end:
 *   parseSse                          (plugin-api/src/utils/sse-parser.ts)
 *     -\> translateOpenAIResponsesStream (plugins/llm-openai/responses/response-stream.ts)
 *     -\> withStreamWatchdog             (src/llm/transport/watchdog.ts)
 *     -\> canonicalEventsToLegacyStream  (src/llm/adapter-legacy.ts)
 *
 * GROUND TRUTH established from the captured data before writing the fix:
 *   - net-dbg: every stalled attempt = exactly 4 SSE events
 *     (response.created, response.in_progress, output_item.added(reasoning),
 *      keepalive), HTTP 200, then the body closes cleanly (last 2 bytes 0a0a).
 *   - timing: headers at ~4s, last keepalive ~4.5s, body closes ~35s.
 *   - session log: 23x `api.retry error-type="api_error"`, and ZERO
 *     `api.stream-stalled` diags. =\> the idle WATCHDOG never fired; the SERVER
 *     closed the stream itself without a terminal event.
 *
 * Fixed behavior:
 *   - keepalive is forwarded as canonical `ping`, so it resets watchdog liveness.
 *   - no-terminal close is tagged `stream_closed_without_terminal`, which retries
 *     on the slow curve instead of the fast `api_error` hammer loop.
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "../../plugin-api/src/llm/canonical-events.ts"
import { parseSse } from "../../plugin-api/src/utils/sse-parser.ts"
import { canonicalEventsToLegacyStream } from "../../src/llm/adapter-legacy.ts"
import { withStreamWatchdog } from "../../src/llm/transport/watchdog.ts"

import {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"

// The exact 4 SSE records every stalled attempt emitted, byte-for-byte from
// net-dbg attempt 024.
const CAPTURED_STALL_BODY = [
  `event: response.created`,
  `data: {"type":"response.created","response":{"id":"resp_x","model":"gpt-5.5","status":"in_progress"}}`,
  ``,
  `event: response.in_progress`,
  `data: {"type":"response.in_progress","response":{"id":"resp_x","model":"gpt-5.5","status":"in_progress"}}`,
  ``,
  `event: response.output_item.added`,
  `data: {"type":"response.output_item.added","item":{"id":"rs_x","type":"reasoning","content":[],"summary":[]},"output_index":0,"sequence_number":2}`,
  ``,
  `event: keepalive`,
  `data: {"type":"keepalive","sequence_number":3}`,
  ``,
  ``,
].join("\n")

/** A ReadableStream that emits `body` bytes then closes cleanly (done=true). */
function bodyThenClose(body: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close() // clean EOF — exactly what the captured 0a0a close is
    },
  })
}

async function runPipeline(
  makeBody: (signal: AbortSignal) => ReadableStream<Uint8Array>,
  idleMs: number,
): Promise<{
  outcome: "completed" | "threw"
  tag?: string
  retryable?: boolean
  message?: string
  ms: number
}> {
  const startedAt = Date.now()
  const makeCanonical = (signal: AbortSignal): AsyncIterable<CanonicalEvent> =>
    translateOpenAIResponsesStream(parseSse<OpenAIResponsesEvent>(makeBody(signal)))
  const watchdogged = withStreamWatchdog(makeCanonical, {
    streamIdleTimeoutMs: idleMs,
    attemptHardTimeoutMs: 30 * 60_000,
  })
  const legacy = canonicalEventsToLegacyStream(watchdogged)
  try {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: draining
    for await (const _ of legacy) {
    }
    return { outcome: "completed", ms: Date.now() - startedAt }
  } catch (err) {
    return {
      outcome: "threw",
      tag: (err as { streamErrorType?: string }).streamErrorType,
      retryable: (err as { retryable?: boolean }).retryable,
      message: (err as Error).message,
      ms: Date.now() - startedAt,
    }
  }
}

describe("gpt-5.5 resume stall — REAL wire bytes + REAL pipeline (session 7919d877)", () => {
  it("PRODUCTION PATH: server closes the SSE stream after a reasoning block with no terminal event -> reclassified off the fast api_error curve", async () => {
    // Deterministic: the captured body, then a clean close. No idle wait — this
    // is the server closing on its own, which is what the log proves happened
    // (formerly api_error, zero stream-stalled diags).
    const r = await runPipeline(() => bodyThenClose(CAPTURED_STALL_BODY), 30_000)
    console.log("[PROD] result:", r)

    expect(r.outcome).toBe("threw")
    expect(r.tag).toBe("stream_closed_without_terminal")
    // Still retryable, but now on the slow curve via retry.ts.
    expect(r.retryable).not.toBe(false)
    // The underlying cause string proves it's the !sawTerminal truncation guard.
    expect(r.message).toContain("closed without a terminal event")
  })

  it("FIXED WATCHDOG: `keepalive` events reset idle liveness, so a slow reasoning stream can complete", async () => {
    // Healthy-but-slow server: opens reasoning, then sends a keepalive every
    // 150ms for ~1.5s (each one PROVES the socket is alive), THEN answers and
    // completes. A correct watchdog treats keepalive as liveness and lets it
    // finish (~1.5s). The translator drops keepalive before it reaches the
    // watchdog (response-stream.ts default case), so lastEventAt never advances.
    function healthyKeepaliveBody(signal: AbortSignal): ReadableStream<Uint8Array> {
      const enc = new TextEncoder()
      let timer: ReturnType<typeof setInterval> | undefined
      let n = 0
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(CAPTURED_STALL_BODY)) // reasoning + 1 keepalive
          timer = setInterval(() => {
            n++
            if (n <= 10) {
              controller.enqueue(enc.encode(`event: keepalive\ndata: {"type":"keepalive"}\n\n`))
              return
            }
            if (timer) clearInterval(timer)
            controller.enqueue(
              enc.encode(
                [
                  `event: response.output_item.added`,
                  `data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_x","role":"assistant"}}`,
                  ``,
                  `event: response.content_part.added`,
                  `data: {"type":"response.content_part.added","output_index":1,"content_index":0,"item_id":"msg_x","part":{"type":"output_text","text":""}}`,
                  ``,
                  `event: response.output_text.delta`,
                  `data: {"type":"response.output_text.delta","output_index":1,"content_index":0,"item_id":"msg_x","delta":"done"}`,
                  ``,
                  `event: response.completed`,
                  `data: {"type":"response.completed","response":{"id":"resp_x","status":"completed"}}`,
                  ``,
                  ``,
                ].join("\n"),
              ),
            )
            controller.close()
          }, 150)
          const onAbort = () => {
            if (timer) clearInterval(timer)
            controller.error(new Error("HTTP/2 stream aborted"))
          }
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        },
        cancel() {
          if (timer) clearInterval(timer)
        },
      })
    }

    // Idle window 400ms < the 1.5s of keepalive activity. A keepalive-aware
    // watchdog would NOT trip (the stream is provably alive every 150ms).
    const r = await runPipeline(healthyKeepaliveBody, 400)
    console.log("[WATCHDOG] result:", r)

    // Fixed: keepalive is now a canonical ping, so the watchdog sees activity
    // every 150ms and allows the stream to reach response.completed.
    expect(r.outcome).toBe("completed")
    expect(r.ms).toBeGreaterThanOrEqual(1400)
  })

  it("CONTROL: same pipeline, a normal completed response -> completes cleanly (harness is sound)", async () => {
    const ok = [
      `event: response.created`,
      `data: {"type":"response.created","response":{"id":"r","model":"gpt-5.5"}}`,
      ``,
      `event: response.output_item.added`,
      `data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"m","role":"assistant"}}`,
      ``,
      `event: response.content_part.added`,
      `data: {"type":"response.content_part.added","output_index":1,"content_index":0,"item_id":"m","part":{"type":"output_text","text":""}}`,
      ``,
      `event: response.output_text.delta`,
      `data: {"type":"response.output_text.delta","output_index":1,"content_index":0,"item_id":"m","delta":"hi"}`,
      ``,
      `event: response.completed`,
      `data: {"type":"response.completed","response":{"id":"r","status":"completed"}}`,
      ``,
      ``,
    ].join("\n")
    const r = await runPipeline(() => bodyThenClose(ok), 30_000)
    console.log("[CONTROL] result:", r)
    expect(r.outcome).toBe("completed")
  })
})

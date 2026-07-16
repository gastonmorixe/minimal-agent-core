/**
 * Wire-level MA-882492 regression: real {@link Http2Transport} + multi-MB body
 * against a local HTTP/2 server that delays response headers past the ordinary
 * mid-stream idle threshold.
 *
 * Scaled clocks (1s watchdog tick):
 * - streamIdleTimeoutMs = 50 → would fire at first tick (~1s) under old code
 * - responseHeadersTimeoutMs = 5000 → pre-stream budget
 * - server holds headers ~1.2s after fully reading the request body
 *
 * Old behavior: abort at ~1s with stream_idle mid-stream-shaped thrash.
 * New behavior: survive pre-stream, complete with first body activity.
 *
 * No credentials, no public network.
 *
 * @module llm/transport/pre-stream-http2.wire.test
 */

import {
  createServer,
  type Http2Server,
  type Http2ServerRequest,
  type Http2ServerResponse,
} from "node:http2"

import { afterEach, describe, expect, it } from "bun:test"

import { NetworkClient } from "../../network/client.ts"
import { Http2Transport } from "../../network/http2-transport.ts"
import type { CanonicalEvent } from "../canonical-events.ts"

import { bindRequestLifecycle } from "./canonical-send.ts"
import { type WatchdogError, withStreamWatchdog } from "./watchdog.ts"

const MULTI_MB = 3 * 1024 * 1024 // 3 MiB synthetic body (incident class, not full 14MB)

function ssePayload(): string {
  // Minimal SSE-shaped body the client will treat as raw bytes then map to events.
  return [
    "data: " +
      JSON.stringify({
        type: "message_start",
        messageId: "wire1",
        modelId: "wire",
        initialUsage: { inputTokens: 1, outputTokens: 0 },
      }),
    "",
    "data: " + JSON.stringify({ type: "message_stop" }),
    "",
    "",
  ].join("\n")
}

async function listenH2(
  onRequest: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
): Promise<{ server: Http2Server; origin: string }> {
  const server = createServer(onRequest)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("expected TCP address")
  return { server, origin: `http://127.0.0.1:${addr.port}` }
}

describe("pre-stream Http2Transport wire (MA-882492)", () => {
  let server: Http2Server | undefined
  let transport: Http2Transport | undefined

  afterEach(async () => {
    await transport?.close()
    transport = undefined
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = undefined
    }
  })

  it("survives multi-MB upload when headers arrive after mid-stream idle threshold", async () => {
    let requestBodyBytes = 0
    let headersSentAt = 0
    const t0 = Date.now()

    const listened = await listenH2((req, res) => {
      req.on("data", (chunk: Buffer) => {
        requestBodyBytes += chunk.length
      })
      req.on("end", () => {
        // Hold headers ~1.2s after full body received — past 1s watchdog tick
        // and far past streamIdleTimeoutMs=50, but under pre-stream 5s.
        setTimeout(() => {
          headersSentAt = Date.now()
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          })
          res.end(ssePayload())
        }, 1200)
      })
    })
    server = listened.server
    const { origin } = listened

    transport = new Http2Transport({ connectTimeoutMs: 5_000 })
    const baseClient = new NetworkClient({ primary: transport })

    let phaseCtl: { markHeadersReceived: () => void; markBodyActivity: () => void } | undefined
    const body = "x".repeat(MULTI_MB)

    const makeStream = (signal: AbortSignal): AsyncIterable<CanonicalEvent> =>
      (async function* () {
        const client = bindRequestLifecycle(baseClient, {
          onHeaders: () => phaseCtl?.markHeadersReceived(),
          onBodyChunk: () => phaseCtl?.markBodyActivity(),
        })
        const res = await client.request({
          label: "prestream-wire",
          method: "POST",
          url: `${origin}/v1/responses`,
          headers: { "content-type": "application/json" },
          body,
          signal,
        })
        // Drain body so lifecycle hooks fire; then yield terminal events.
        const reader = res.body.getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
        yield {
          type: "message_start",
          messageId: "wire1",
          modelId: "wire",
          initialUsage: { inputTokens: 1, outputTokens: 0 },
        } satisfies CanonicalEvent
        yield { type: "message_stop" } satisfies CanonicalEvent
      })()

    const events: CanonicalEvent[] = []
    let caught: WatchdogError | undefined
    try {
      for await (const ev of withStreamWatchdog(makeStream, {
        streamIdleTimeoutMs: 50,
        responseHeadersTimeoutMs: 5_000,
        attemptHardTimeoutMs: 30_000,
        onBindPhaseControl: (ctl) => {
          phaseCtl = ctl
        },
      })) {
        events.push(ev)
      }
    } catch (e) {
      caught = e as WatchdogError
    }

    const elapsed = Date.now() - t0
    expect(caught).toBeUndefined()
    expect(events.some((e) => e.type === "message_stop")).toBe(true)
    expect(requestBodyBytes).toBe(MULTI_MB)
    // Headers must have been delayed past the 1s mid-stream tick window.
    expect(headersSentAt - t0).toBeGreaterThanOrEqual(1100)
    // Whole attempt should have taken >1s (old code would have aborted ~1s).
    expect(elapsed).toBeGreaterThanOrEqual(1100)
    expect(elapsed).toBeLessThan(5000)
  }, 20_000)
})

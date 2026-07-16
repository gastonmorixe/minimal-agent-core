/**
 * Unit tests for {@link bindRequestLifecycle} (MA-882492).
 *
 * Proves the NetworkClient wrapper emits headers + every non-empty body
 * chunk and forwards cancel — coverage the pure watchdog phaseCtl tests
 * cannot provide.
 *
 * @module llm/transport/canonical-send.lifecycle.test
 */

import { describe, expect, it } from "bun:test"

import { NetworkClient, NetworkResponse, type NetworkTransport } from "../../network/index.ts"

import { bindRequestLifecycle } from "./canonical-send.ts"

function clientWithHandler(
  handler: (signal?: AbortSignal) => Promise<NetworkResponse>,
): NetworkClient {
  const transport: NetworkTransport = {
    id: "fake",
    request: async (req) => handler(req.signal),
  }
  return new NetworkClient({ primary: transport })
}

describe("bindRequestLifecycle", () => {
  it("calls onHeaders when request resolves and onBodyChunk for every non-empty chunk", async () => {
    const headers: number[] = []
    const bodies: number[] = []
    const encoder = new TextEncoder()
    const base = clientWithHandler(async () => {
      return new NetworkResponse({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        transport: { id: "fake", protocol: "h2" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            // SSE comment / keepalive-shaped bytes (no CanonicalEvent needed).
            controller.enqueue(encoder.encode(": keepalive\n\n"))
            controller.enqueue(encoder.encode('data: {"x":1}\n\n'))
            controller.enqueue(new Uint8Array(0)) // empty: must NOT count
            controller.close()
          },
        }),
      })
    })

    const wrapped = bindRequestLifecycle(base, {
      onHeaders: () => headers.push(Date.now()),
      onBodyChunk: () => bodies.push(Date.now()),
    })

    const res = await wrapped.request({
      label: "test",
      method: "POST",
      url: "https://example.test/v1",
      body: "{}",
    })
    expect(headers.length).toBe(1)
    expect(bodies.length).toBe(0) // lazy: not until body is read

    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    // Data chunks stay intact; only non-empty chunks fire onBodyChunk (bodies=2).
    expect(chunks.length).toBe(3)
    expect(bodies.length).toBe(2)
  })

  it("forwards cancel to the upstream body reader", async () => {
    let cancelled = false
    const base = clientWithHandler(async () => {
      return new NetworkResponse({
        status: 200,
        headers: {},
        transport: { id: "fake" },
        body: new ReadableStream<Uint8Array>({
          start() {
            // never closes
          },
          cancel() {
            cancelled = true
          },
        }),
      })
    })

    const wrapped = bindRequestLifecycle(base, {})
    const res = await wrapped.request({
      label: "test",
      method: "GET",
      url: "https://example.test/",
    })
    // Pull once so the lazy reader is acquired, then cancel.
    const reader = res.body.getReader()
    const pull = reader.read()
    await reader.cancel("test-cancel")
    await pull.catch(() => undefined)
    expect(cancelled).toBe(true)
  })

  it("preserves status, headers, and transport from the inner response", async () => {
    const base = clientWithHandler(async () => {
      return new NetworkResponse({
        status: 201,
        headers: { "x-test": "1" },
        transport: { id: "fake", protocol: "h2", origin: "https://example.test" },
        body: emptyClosedBody(),
      })
    })
    const wrapped = bindRequestLifecycle(base, {})
    const res = await wrapped.request({
      label: "t",
      method: "POST",
      url: "https://example.test/",
      body: "{}",
    })
    expect(res.status).toBe(201)
    expect(res.headers.get("x-test")).toBe("1")
    expect(res.transport.id).toBe("fake")
    expect(res.transport.protocol).toBe("h2")
  })
})

function emptyClosedBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.close()
    },
  })
}

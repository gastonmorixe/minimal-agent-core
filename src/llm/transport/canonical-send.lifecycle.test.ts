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

import { StatusBus } from "../../bus/status.ts"
import {
  NetworkClient,
  NetworkResponse,
  type NetworkTransport,
  networkActivityObserver,
} from "../../network/index.ts"

import { bindPrimaryStreamRequest, bindRequestLifecycle } from "./canonical-send.ts"

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

describe("bindPrimaryStreamRequest — stream vs side-probe isolation", () => {
  it("does not mark body activity from concurrent billing after SSE headers (billing probe)", async () => {
    const encoder = new TextEncoder()
    const transport: NetworkTransport = {
      id: "fake",
      request: async (req) => {
        if (req.label === "llm.responses") {
          return new NetworkResponse({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            transport: { id: "fake", protocol: "h2" },
            body: new ReadableStream<Uint8Array>({
              start() {
                // No body bytes yet — pre-stream until SSE arrives.
              },
            }),
          })
        }
        if (req.label === "llm.billing") {
          return new NetworkResponse({
            status: 200,
            headers: { "content-type": "application/json" },
            transport: { id: "fake", protocol: "h2" },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('{"ok":true}'))
                controller.close()
              },
            }),
          })
        }
        throw new Error(`unexpected label ${req.label}`)
      },
    }
    const realBase = new NetworkClient({ primary: transport })
    const bus = new StatusBus()
    const handle = bus.create("Sending request")
    const headers: number[] = []
    const bodies: number[] = []
    const { client, detach } = bindPrimaryStreamRequest(realBase, {
      statusHandle: handle,
      onHeaders: () => headers.push(1),
      onBodyChunk: () => bodies.push(1),
    })

    const streamRes = await client.request({
      label: "llm.responses",
      method: "POST",
      url: "https://example.test/v1/responses",
      body: "{}",
    })
    expect(headers).toEqual([1])
    expect(bodies).toEqual([])

    // Concurrent billing probe — must not end pre-stream / refresh mid-stream.
    const billingRes = await client.request({
      label: "llm.billing",
      method: "GET",
      url: "https://example.test/v1/billing",
    })
    await billingRes.text()
    expect(bodies).toEqual([])

    // Distinct wire ids.
    // Drain stream later would mark activity; still none from billing.
    expect(streamRes.headers.get("content-type")).toContain("text/event-stream")
    detach()
    handle.clear()
  })

  it("assigns distinct wire ids to stream and billing and only tracks the stream", async () => {
    const encoder = new TextEncoder()
    const seen: Array<{ id: string; label: string }> = []
    const transport: NetworkTransport = {
      id: "fake",
      request: async (req) => {
        seen.push({ id: req.id, label: req.label })
        if (req.label === "llm.responses") {
          return new NetworkResponse({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            transport: { id: "fake" },
            body: new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(encoder.encode(": keepalive\n\n"))
                c.close()
              },
            }),
          })
        }
        return new NetworkResponse({
          status: 200,
          headers: { "content-type": "application/json" },
          transport: { id: "fake" },
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(encoder.encode("{}"))
              c.close()
            },
          }),
        })
      },
    }
    const base = new NetworkClient({ primary: transport })
    const bus = new StatusBus()
    const handle = bus.create("Sending request")
    const bodies: number[] = []
    const { client, detach } = bindPrimaryStreamRequest(base, {
      statusHandle: handle,
      onBodyChunk: () => bodies.push(1),
    })

    const stream = await client.request({
      label: "llm.responses",
      method: "POST",
      url: "https://example.test/v1/responses",
      body: "{}",
    })
    const bodiesAfterStreamHeaders = bodies.length

    await client
      .request({
        label: "llm.billing",
        method: "GET",
        url: "https://example.test/v1/billing",
      })
      .then((r) => r.text())

    // Billing must not add body-activity marks.
    expect(bodies.length).toBe(bodiesAfterStreamHeaders)

    await stream.text()
    expect(bodies.length).toBeGreaterThan(bodiesAfterStreamHeaders)

    expect(seen).toHaveLength(2)
    expect(seen[0]!.label).toBe("llm.responses")
    expect(seen[1]!.label).toBe("llm.billing")
    expect(seen[0]!.id).not.toBe(seen[1]!.id)
    detach()
    handle.clear()
  })

  it("does not attach lifecycle/activity for known non-stream POST labels (oauth)", async () => {
    const encoder = new TextEncoder()
    const transport: NetworkTransport = {
      id: "fake",
      request: async () =>
        new NetworkResponse({
          status: 200,
          headers: { "content-type": "application/json" },
          transport: { id: "fake" },
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(encoder.encode("{}"))
              c.close()
            },
          }),
        }),
    }
    const base = new NetworkClient({ primary: transport })
    const bus = new StatusBus()
    const handle = bus.create("Sending request")
    const headers: number[] = []
    const bodies: number[] = []
    const { client, detach } = bindPrimaryStreamRequest(base, {
      statusHandle: handle,
      onHeaders: () => headers.push(1),
      onBodyChunk: () => bodies.push(1),
    })
    const res = await client.request({
      label: "llm.oauth.refresh",
      method: "POST",
      url: "https://auth.example.test/oauth/token",
      body: "{}",
    })
    await res.text()
    expect(headers).toEqual([])
    expect(bodies).toEqual([])
    detach()
    handle.clear()
  })

  it("paints ↑/host activity on Sending request before response headers (pre-TTFB)", async () => {
    // Regression: attach used to wait until onResponse, so long TTFB left the
    // status row as bare "Sending request (Ns)" with no activity infix.
    // bindPrimaryStreamRequest must attach on reservation so NetworkClient's
    // onRequest can publish direction:up / sentBytes / host immediately.
    const body = `{"messages":[${"x".repeat(200)}]}`
    let releaseHeaders!: () => void
    const headersGate = new Promise<void>((resolve) => {
      releaseHeaders = resolve
    })
    const transport: NetworkTransport = {
      id: "fake",
      request: async () => {
        await headersGate
        return new NetworkResponse({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          transport: { id: "fake", protocol: "h2" },
          body: emptyClosedBody(),
        })
      },
    }
    // Wire the process-wide singleton that bindPrimaryStreamRequest attaches to.
    const base = new NetworkClient({
      primary: transport,
      observers: [networkActivityObserver],
    })
    const bus = new StatusBus()
    const handle = bus.create("Sending request")
    const { client, detach } = bindPrimaryStreamRequest(base, { statusHandle: handle })

    const pending = client.request({
      label: "llm.responses",
      method: "POST",
      url: "https://example.test/v1/responses",
      body,
    })

    // Yield so NetworkClient can fire onRequest before headers resolve.
    await Promise.resolve()
    await Promise.resolve()

    const preHeaders = bus.currentStatus()?.activity
    expect(preHeaders?.direction).toBe("up")
    expect(preHeaders?.sentBytes).toBe(Buffer.byteLength(body, "utf8"))
    expect(preHeaders?.target?.host).toBe("example.test")
    // Still pre-headers: protocol comes from onResponse.
    expect(preHeaders?.target?.protocol).toBeUndefined()

    releaseHeaders()
    const res = await pending
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(bus.currentStatus()?.activity?.target?.protocol).toBe("h2")

    detach()
    handle.clear()
  })

  it("detaches activity when a reserved POST turns out non-stream (JSON)", async () => {
    const body = '{"ok":true}'
    const transport: NetworkTransport = {
      id: "fake",
      request: async () =>
        new NetworkResponse({
          status: 200,
          headers: { "content-type": "application/json" },
          transport: { id: "fake", protocol: "h2" },
          body: emptyClosedBody(),
        }),
    }
    const base = new NetworkClient({
      primary: transport,
      observers: [networkActivityObserver],
    })
    const bus = new StatusBus()
    const handle = bus.create("Sending request")
    const { client, detach } = bindPrimaryStreamRequest(base, { statusHandle: handle })

    await client.request({
      label: "some.json.post",
      method: "POST",
      url: "https://api.example.com/v1/json",
      body,
    })

    // Non-stream response must detach the reservation so a later real stream
    // can claim activity. Tracker should no longer be registered.
    expect(networkActivityObserver.size()).toBe(0)

    detach()
    handle.clear()
  })
})

function emptyClosedBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.close()
    },
  })
}

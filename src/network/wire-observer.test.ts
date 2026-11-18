/**
 * Run-time network observers: `NetworkClient.addObserver` and the guarded
 * plugin adapter behind the `network:observe` capability.
 */

import { describe, expect, it } from "bun:test"

import type { NetworkWireObserver } from "@minimal-agent/core/plugin-api/net/types"

import type { Diagnostics } from "../diagnostics/hub.ts"

import { NetworkClient, withRequestDiagnostics } from "./client.ts"
import {
  type NetworkObserver,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "./types.ts"
import { createNetworkObserveApi, createWireObserver } from "./wire-observer.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Transport that answers every request with `chunks` as the body. */
function chunkTransport(chunks: string[], fail = false): NetworkTransport {
  return {
    id: "test",
    request: async () =>
      new NetworkResponse({
        status: 200,
        headers: { "content-type": "text/event-stream", "set-cookie": "sid=secret" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
            if (fail) controller.error(new Error("stream died"))
            else controller.close()
          },
        }),
        transport: { id: "test", protocol: "h2" },
      }),
  }
}

function request(extra: Partial<NetworkRequest> = {}) {
  return {
    label: "test.stream",
    method: "POST" as const,
    url: "https://example.test/v1/responses",
    headers: { authorization: "Bearer sk-secret", accept: "application/json" },
    body: JSON.stringify({ model: "m", refresh_token: "rt-secret" }),
    ...extra,
  }
}

/** Diagnostics handle that records `warn` calls. */
function recordingDiagnostics(): { diagnostics: Diagnostics; warnings: string[] } {
  const warnings: string[] = []
  const noop = () => {}
  const diagnostics: Diagnostics = {
    sessionId: undefined,
    emit: noop,
    emergency: noop,
    alert: noop,
    critical: noop,
    error: noop,
    warn: (source, message) => warnings.push(`${source}: ${message}`),
    notice: noop,
    info: noop,
    debug: noop,
  }
  return { diagnostics, warnings }
}

describe("NetworkClient.addObserver", () => {
  it("adds an observer after the built-in ones, and removes it", async () => {
    const order: string[] = []
    const builtIn: NetworkObserver = { onChunk: () => order.push("built-in") }
    const client = new NetworkClient({ primary: chunkTransport(["a"]), observers: [builtIn] })
    const remove = client.addObserver({ onChunk: () => order.push("added") })

    await (await client.request(request())).text()
    expect(order).toEqual(["built-in", "added"])

    remove()
    remove()
    await (await client.request(request())).text()
    expect(order).toEqual(["built-in", "added", "built-in"])
  })

  it("reaches the client through a withRequestDiagnostics view, both ways", async () => {
    const client = new NetworkClient({ primary: chunkTransport(["a"]) })
    const view = withRequestDiagnostics(client, recordingDiagnostics().diagnostics)
    let viaView = 0
    let viaClient = 0
    view.addObserver({ onChunk: () => viaView++ })
    client.addObserver({ onChunk: () => viaClient++ })

    await (await client.request(request())).text()
    await (await view.request(request())).text()
    expect(viaView).toBe(2)
    expect(viaClient).toBe(2)
  })
})

describe("createWireObserver", () => {
  it("sees the raw bytes before the consumer reads them", async () => {
    const events: string[] = []
    const client = new NetworkClient({ primary: chunkTransport(["he", "llo"]) })
    client.addObserver(
      createWireObserver({
        onRequest: (req) => events.push(`request ${req.label}`),
        onResponse: (_req, res) => events.push(`response ${res.status}`),
        onChunk: (_req, chunk) => events.push(`wire ${decoder.decode(chunk)}`),
        onEnd: () => events.push("end"),
      }),
    )

    const response = await client.request(request())
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      events.push(`consumer ${decoder.decode(value)}`)
    }

    expect(events).toEqual([
      "request test.stream",
      "response 200",
      "wire he",
      "consumer he",
      "wire llo",
      "consumer llo",
      "end",
    ])
  })

  it("cannot change the bytes the consumer and later observers read", async () => {
    const captured: string[] = []
    const client = new NetworkClient({ primary: chunkTransport(["raw"]) })
    client.addObserver(createWireObserver({ onChunk: (_req, chunk) => chunk.fill(0x58) }))
    // A later observer (stands for any host observer) still gets the raw bytes.
    client.addObserver({ onChunk: (_req, chunk) => captured.push(decoder.decode(chunk)) })

    expect(await (await client.request(request())).text()).toBe("raw")
    expect(captured).toEqual(["raw"])
  })

  it("hands out frozen copies with redacted credentials", async () => {
    const seen: Parameters<NonNullable<NetworkWireObserver["onResponse"]>>[] = []
    const client = new NetworkClient({ primary: chunkTransport(["a"]) })
    client.addObserver(createWireObserver({ onResponse: (req, res) => seen.push([req, res]) }))
    await (await client.request(request())).text()

    const [req, res] = seen[0]!
    expect(req.headers).toEqual({ authorization: "Bearer [REDACTED]", accept: "application/json" })
    expect(req.body).toBe('{"model":"m","refresh_token":"[REDACTED]"}')
    expect(res.headers["set-cookie"]).toBe("[REDACTED]")
    expect(res.headers["content-type"]).toBe("text/event-stream")
    expect(res.transport.protocol).toBe("h2")
    expect(Object.isFrozen(req)).toBe(true)
    expect(Object.isFrozen(req.headers)).toBe(true)
    expect(Object.isFrozen(res)).toBe(true)
    expect(JSON.stringify(seen)).not.toContain("secret")
  })

  it("honors a request that opts out of body capture", async () => {
    const bodies: string[] = []
    let chunks = 0
    const client = new NetworkClient({ primary: chunkTransport(["token-response"]) })
    client.addObserver(
      createWireObserver({
        onRequest: (req) => bodies.push(req.body),
        onChunk: () => chunks++,
      }),
    )
    const response = await client.request(
      request({ capture: { requestBody: "[REDACTED OAUTH EXCHANGE BODY]", responseBody: false } }),
    )
    expect(await response.text()).toBe("token-response")
    expect(bodies).toEqual(["[REDACTED OAUTH EXCHANGE BODY]"])
    expect(chunks).toBe(0)
  })

  it("contains an observer that throws, and reports it once", async () => {
    const { diagnostics, warnings } = recordingDiagnostics()
    const client = new NetworkClient({ primary: chunkTransport(["a", "b"]) })
    client.addObserver(
      createWireObserver(
        {
          onRequest: () => {
            throw new Error("boom")
          },
          onChunk: () => {
            throw new Error("boom again")
          },
        },
        { owner: "bad-plugin" },
      ),
    )
    const response = await client.request(request({ diagnostics }))
    expect(await response.text()).toBe("ab")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("network.wire-observer")
    expect(warnings[0]).toContain("bad-plugin")
    expect(warnings[0]).toContain("boom")
  })

  it("reports a failed body through onError", async () => {
    const errors: unknown[] = []
    const client = new NetworkClient({ primary: chunkTransport(["a"], true) })
    client.addObserver(createWireObserver({ onError: (_req, err) => errors.push(err) }))
    const response = await client.request(request())
    await expect(response.text()).rejects.toThrow("stream died")
    expect(errors).toHaveLength(1)
  })
})

describe("createNetworkObserveApi", () => {
  it("observes until the returned function is called", async () => {
    const client = new NetworkClient({ primary: chunkTransport(["a"]) })
    const api = createNetworkObserveApi(client)
    let chunks = 0
    const stop = api.observe({ onChunk: () => chunks++ })
    await (await client.request(request())).text()
    stop()
    await (await client.request(request())).text()
    expect(chunks).toBe(1)
  })

  it("gives the same frozen object for the same client and owner", () => {
    const client = new NetworkClient({ primary: chunkTransport(["a"]) })
    const other = new NetworkClient({ primary: chunkTransport(["a"]) })
    const a = createNetworkObserveApi(client, { owner: "cache" })
    expect(createNetworkObserveApi(client, { owner: "cache" })).toBe(a)
    expect(Object.isFrozen(a)).toBe(true)
    expect(createNetworkObserveApi(client, { owner: "other" })).not.toBe(a)
    expect(createNetworkObserveApi(other, { owner: "cache" })).not.toBe(a)
  })
})

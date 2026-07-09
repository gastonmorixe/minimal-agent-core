import { EventEmitter } from "node:events"
import type { Http2Server, ServerHttp2Stream } from "node:http2"
import { createServer } from "node:http2"

import { describe, expect, it } from "bun:test"

import { isPlaintextHttp } from "./client.ts"
import { _nodeStreamToWebForTest } from "./http2-transport.ts"
import {
  defaultNetworkClient,
  Http2Transport,
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "./index.ts"
import { TRANSIENT_NETWORK_STREAM_ERROR_TYPE } from "./transient-error.ts"

describe("network", () => {
  it("reuses one HTTP/2 session for sequential same-origin requests", async () => {
    const { server, url, sessions } = await startHttp2Server()
    const transport = new Http2Transport()
    const client = new NetworkClient({ primary: transport })

    try {
      const first = await client.request({
        label: "test.first",
        method: "GET",
        url: `${url}/first`,
      })
      const second = await client.request({
        label: "test.second",
        method: "GET",
        url: `${url}/second`,
      })

      expect(first.transport.protocol).toBe("h2")
      expect(first.transport.reused).toBe(false)
      expect(second.transport.reused).toBe(true)
      expect(sessions.size).toBe(1)
      expect(await first.json<{ path: string }>()).toEqual({ path: "/first" })
      expect(await second.json<{ path: string }>()).toEqual({ path: "/second" })
    } finally {
      await client.close()
      await closeServer(server)
    }
  })

  it("multiplexes concurrent requests over one HTTP/2 session", async () => {
    const { server, url, sessions } = await startHttp2Server()
    const transport = new Http2Transport()
    const client = new NetworkClient({ primary: transport })

    try {
      const [first, second] = await Promise.all([
        client.request({ label: "test.a", method: "GET", url: `${url}/a` }),
        client.request({ label: "test.b", method: "GET", url: `${url}/b` }),
      ])

      expect(sessions.size).toBe(1)
      expect(first.transport.protocol).toBe("h2")
      expect(second.transport.protocol).toBe("h2")
      expect(await first.json<{ path: string }>()).toEqual({ path: "/a" })
      expect(await second.json<{ path: string }>()).toEqual({ path: "/b" })
    } finally {
      await client.close()
      await closeServer(server)
    }
  })

  it("routes plaintext http:// to the plaintextHttpTransport, https:// to primary", async () => {
    const primary = labeledTransport("primary")
    const plaintextHttpTransport = labeledTransport("plaintext")
    const client = new NetworkClient({ primary, plaintextHttpTransport })

    const httpRes = await client.request({
      label: "t.http",
      method: "GET",
      url: "http://192.168.1.40:8000/v1/chat/completions",
    })
    const httpsRes = await client.request({
      label: "t.https",
      method: "GET",
      url: "https://api.example.com/v1/chat/completions",
    })

    expect(httpRes.transport.id).toBe("plaintext")
    expect(httpsRes.transport.id).toBe("primary")
  })

  it("an explicit protocol pin still wins over the plaintext auto-route", async () => {
    const primary = labeledTransport("primary")
    const plaintextHttpTransport = labeledTransport("plaintext")
    const h3 = labeledTransport("h3")
    const client = new NetworkClient({
      primary,
      plaintextHttpTransport,
      transports: new Map([["h3", h3]]),
    })

    const res = await client.request({
      label: "t.pinned",
      method: "GET",
      url: "http://192.168.1.40:8000/v1/chat/completions",
      protocol: "h3",
    })
    expect(res.transport.id).toBe("h3")
  })

  it("falls back to primary for plaintext http:// when no plaintextHttpTransport is set", async () => {
    const primary = labeledTransport("primary")
    const client = new NetworkClient({ primary })
    const res = await client.request({
      label: "t.noroute",
      method: "GET",
      url: "http://192.168.1.40:8000/v1/chat/completions",
    })
    expect(res.transport.id).toBe("primary")
  })

  it("isPlaintextHttp: true for http, false for https/malformed", () => {
    expect(isPlaintextHttp("http://192.168.1.40:8000/v1/chat/completions")).toBe(true)
    expect(isPlaintextHttp("http://localhost:1234")).toBe(true)
    expect(isPlaintextHttp("https://api.example.com")).toBe(false)
    expect(isPlaintextHttp("not a url")).toBe(false)
  })

  it("does not use fetch fallback unless fallback is enabled", async () => {
    const primary = failingTransport()
    const fallback = textTransport("fallback-ok")
    const client = new NetworkClient({ primary, fallback })

    const failure = await client
      .request({
        label: "test.no-fallback",
        method: "GET",
        url: "https://example.com/",
      })
      .then(
        () => "resolved",
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      )
    expect(failure).toBe("primary failed")
  })

  it("uses fetch fallback when fallback is enabled", async () => {
    const primary = failingTransport()
    const fallback = textTransport("fallback-ok")
    const client = new NetworkClient({
      primary,
      fallback,
      allowFetchFallback: true,
    })

    const response = await client.request({
      label: "test.fallback",
      method: "GET",
      url: "https://example.com/",
    })

    expect(response.transport.id).toBe("fake-fetch")
    expect(response.transport.fallbackUsed).toBe(true)
    expect(await response.text()).toBe("fallback-ok")
  })

  it("closes the web body when an HTTP/2 stream ends before close", async () => {
    const stream = new FakeHttp2Stream()
    let doneCount = 0
    const body = _nodeStreamToWebForTest(stream as never, () => {
      doneCount++
    })
    const reader = body.getReader()

    stream.emit("data", new TextEncoder().encode("data: ping\\n\\n"))
    const first = await reader.read()
    expect(first.done).toBe(false)

    const pending = reader.read()
    stream.readableEnded = true
    stream.emit("end")
    stream.emit("close")

    const second = await pending
    expect(second).toEqual({ done: true, value: undefined })
    expect(doneCount).toBe(1)

    stream.emit("error", new Error("late"))
    stream.emit("aborted")
    expect(doneCount).toBe(1)
  })

  it("errors the web body with network_error when an HTTP/2 stream closes before end", async () => {
    const stream = new FakeHttp2Stream()
    let doneCount = 0
    const body = _nodeStreamToWebForTest(stream as never, () => {
      doneCount++
    })
    const reader = body.getReader()

    stream.emit("data", new TextEncoder().encode("data: ping\\n\\n"))
    const first = await reader.read()
    expect(first.done).toBe(false)

    const pending = reader.read()
    stream.readableEnded = false
    stream.emit("close")

    let caught: (Error & { streamErrorType?: string }) | undefined
    try {
      await pending
    } catch (err) {
      caught = err as Error & { streamErrorType?: string }
    }
    expect(caught?.message).toBe("HTTP/2 stream closed before end")
    expect(caught?.streamErrorType).toBe(TRANSIENT_NETWORK_STREAM_ERROR_TYPE)
    expect(doneCount).toBe(1)

    stream.emit("end")
    stream.emit("error", new Error("late"))
    stream.emit("aborted")
    expect(doneCount).toBe(1)
  })

  it.skipIf(!process.env.E2E)(
    "live model request uses HTTP/2",
    async () => {
      const response = await defaultNetworkClient.request({
        label: "e2e.models",
        method: "GET",
        url: "https://api.example.com/v1/models?beta=true",
        headers: { accept: "application/json" },
      })

      expect(response.status).toBe(200)
      expect(response.transport.protocol).toBe("h2")
      const data = await response.json<{ data: unknown[] }>()
      expect(Array.isArray(data.data)).toBe(true)
      expect(data.data.length).toBeGreaterThan(0)
    },
    30_000,
  )
})

async function startHttp2Server(): Promise<{
  server: Http2Server
  url: string
  sessions: Set<unknown>
}> {
  const server = createServer()
  const sessions = new Set<unknown>()

  server.on("stream", (stream: ServerHttp2Stream, headers) => {
    sessions.add(stream.session)
    const pathHeader = headers[":path"]
    const path = Array.isArray(pathHeader) ? (pathHeader[0] ?? "/") : (pathHeader ?? "/")
    setTimeout(() => {
      stream.respond({
        ":status": 200,
        "content-type": "application/json",
      })
      stream.end(JSON.stringify({ path }))
    }, 5)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("HTTP/2 test server did not bind to a TCP port")
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    sessions,
  }
}

async function closeServer(server: Http2Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

/** A transport that echoes its own id on the response so tests can assert routing. */
function labeledTransport(id: string): NetworkTransport {
  return {
    id,
    async request(req: NetworkRequest) {
      return new NetworkResponse({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(id))
            controller.close()
          },
        }),
        transport: {
          id,
          protocol: "http/1.1",
          origin: new URL(req.url).origin,
          fallbackUsed: false,
        },
      })
    },
  }
}

class FakeHttp2Stream extends EventEmitter {
  paused = false
  closed = false
  readableEnded = false

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  close(): void {
    this.closed = true
    this.emit("close")
  }
}

function failingTransport(): NetworkTransport {
  return {
    id: "failing",
    async request() {
      throw new Error("primary failed")
    },
  }
}

function textTransport(text: string): NetworkTransport {
  return {
    id: "fake-fetch",
    async request(req: NetworkRequest) {
      return new NetworkResponse({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text))
            controller.close()
          },
        }),
        transport: {
          id: "fake-fetch",
          protocol: "http/1.1",
          origin: new URL(req.url).origin,
          fallbackUsed: false,
        },
      })
    },
  }
}

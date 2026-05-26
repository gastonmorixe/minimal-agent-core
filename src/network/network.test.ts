import type { Http2Server, ServerHttp2Stream } from "node:http2"
import { createServer } from "node:http2"

import { describe, expect, it } from "bun:test"

import { getAuth } from "../auth.ts"
import { buildHeaders } from "../headers.ts"
import { getSessionId } from "../metadata.ts"

import {
  defaultNetworkClient,
  Http2Transport,
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "./index.ts"

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

  it.skipIf(!process.env.E2E)(
    "live Anthropic model request uses HTTP/2",
    async () => {
      const auth = await getAuth()
      const response = await defaultNetworkClient.request({
        label: "e2e.models",
        method: "GET",
        url: "https://api.anthropic.com/v1/models?beta=true",
        headers: buildHeaders(auth, getSessionId()),
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

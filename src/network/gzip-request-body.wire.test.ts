/**
 * Wire-level check that a gzipped request body survives the REAL transports
 * intact: `Http2Transport` (the default path, h2c here) and `FetchTransport`
 * (the fallback). The Anthropic adapter hands the client a `Uint8Array` plus
 * `content-encoding: gzip`; this pins that neither transport corrupts the
 * bytes, drops the header, or sends a wrong `content-length`.
 *
 * No credentials, no public network.
 *
 * @module network/gzip-request-body.wire.test
 */

import { createServer, type Http2Server } from "node:http2"

import { afterEach, describe, expect, it } from "bun:test"

import { NetworkClient } from "./client.ts"
import { FetchTransport } from "./fetch-transport.ts"
import { Http2Transport } from "./http2-transport.ts"

interface Seen {
  encoding: string | undefined
  contentLength: string | undefined
  received: number
  decoded: string
}

function payload(n: number): string {
  return JSON.stringify({
    messages: Array.from({ length: n }, (_, i) => ({
      role: "user",
      content: `turn ${i} héllo 世界 🙂`,
    })),
  })
}

describe("gzip request body over real transports", () => {
  let server: Http2Server | undefined
  let h2: Http2Transport | undefined

  afterEach(async () => {
    await h2?.close()
    h2 = undefined
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
  })

  async function listen(seen: Seen[]): Promise<string> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const raw = Buffer.concat(chunks)
        const enc = req.headers["content-encoding"] as string | undefined
        const decoded = enc === "gzip" ? Bun.gunzipSync(raw) : raw
        seen.push({
          encoding: enc,
          contentLength: req.headers["content-length"] as string | undefined,
          received: raw.length,
          decoded: new TextDecoder().decode(decoded),
        })
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.end("data: {}\n\n")
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(0, "127.0.0.1", () => resolve())
    })
    const addr = server.address()
    if (!addr || typeof addr === "string") throw new Error("no addr")
    return `http://127.0.0.1:${addr.port}`
  }

  for (const size of [50, 5_000, 120_000]) {
    it(`Http2Transport delivers a gzipped body intact (${size} turns)`, async () => {
      const seen: Seen[] = []
      const origin = await listen(seen)
      h2 = new Http2Transport({ connectTimeoutMs: 5_000 })
      const client = new NetworkClient({ primary: h2 })
      const json = payload(size)
      const gz = Bun.gzipSync(json, { level: 6 })
      const res = await client.request({
        label: "gzip-wire",
        method: "POST",
        url: `${origin}/v1/messages`,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: gz,
      })
      await res.text()
      expect(res.status).toBe(200)
      expect(seen[0]!.encoding).toBe("gzip")
      expect(seen[0]!.received).toBe(gz.length)
      expect(seen[0]!.decoded).toBe(json)
      if (seen[0]!.contentLength !== undefined)
        expect(Number(seen[0]!.contentLength)).toBe(gz.length)
    })
  }

  it("FetchTransport (fallback) delivers a gzipped body intact with the right length", async () => {
    const seen: Seen[] = []
    // fetch speaks HTTP/1.1, so use a plain Bun.serve for the fallback leg.
    const bun = Bun.serve({
      port: 0,
      async fetch(req) {
        const raw = new Uint8Array(await req.arrayBuffer())
        const enc = req.headers.get("content-encoding") ?? undefined
        seen.push({
          encoding: enc,
          contentLength: req.headers.get("content-length") ?? undefined,
          received: raw.length,
          decoded: new TextDecoder().decode(enc === "gzip" ? Bun.gunzipSync(raw) : raw),
        })
        return new Response("ok")
      },
    })
    try {
      const client = new NetworkClient({ primary: new FetchTransport() })
      const json = payload(20_000)
      const gz = Bun.gzipSync(json, { level: 6 })
      const res = await client.request({
        label: "gzip-wire-fetch",
        method: "POST",
        url: `http://127.0.0.1:${bun.port}/v1/messages`,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: gz,
      })
      await res.text()
      expect(seen[0]!.encoding).toBe("gzip")
      expect(seen[0]!.received).toBe(gz.length)
      expect(Number(seen[0]!.contentLength)).toBe(gz.length)
      expect(seen[0]!.decoded).toBe(json)
    } finally {
      await bun.stop(true)
    }
  })
})

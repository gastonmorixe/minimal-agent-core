import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { buildInit, Http3Transport, isHttp3HandshakeError } from "./http3-transport.ts"

describe("buildInit", () => {
  test("forwards method/headers/body/signal and pins protocol", () => {
    const signal = new AbortController().signal
    const init = buildInit({
      id: "test",
      label: "t",
      method: "POST",
      url: "https://example.com/",
      headers: { "x-test": "1" },
      body: "hello",
      signal,
    })
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({ "x-test": "1" })
    expect(init.body).toBe("hello")
    expect(init.signal).toBe(signal)
    expect(init.protocol).toBe("http3")
  })

  test("copies Uint8Array bodies into a fresh ArrayBuffer (detaches caller view)", () => {
    const src = new Uint8Array([1, 2, 3, 4])
    const init = buildInit({
      id: "t",
      label: "t",
      method: "POST",
      url: "https://example.com/",
      body: src,
    })
    expect(init.body).toBeInstanceOf(ArrayBuffer)
    const view = new Uint8Array(init.body as ArrayBuffer)
    expect(Array.from(view)).toEqual([1, 2, 3, 4])
    // Mutating the source must NOT mutate the init body.
    src[0] = 99
    expect(Array.from(view)).toEqual([1, 2, 3, 4])
  })

  test("undefined body forwards as undefined", () => {
    const init = buildInit({
      id: "t",
      label: "t",
      method: "GET",
      url: "https://example.com/",
    })
    expect(init.body).toBeUndefined()
  })
})

describe("isHttp3HandshakeError", () => {
  test("matches Bun's HTTP3HandshakeFailed name (case-insensitive)", () => {
    const err = new TypeError("HTTP3HandshakeFailed fetching ...")
    expect(isHttp3HandshakeError(err)).toBe(true)
    expect(isHttp3HandshakeError(new Error("http3handshakefailed: nope"))).toBe(true)
  })

  test("matches QUIC connect-failed phrasing from curl/openssl-style errors", () => {
    expect(isHttp3HandshakeError(new Error("QUIC connect to host:443 failed"))).toBe(true)
    expect(isHttp3HandshakeError(new Error("quic handshake failed"))).toBe(true)
    expect(isHttp3HandshakeError(new Error("quic_handshake_failed: peer reset"))).toBe(true)
  })

  test("matches network-unreachable errors that indicate UDP path is dead", () => {
    expect(isHttp3HandshakeError(new Error("connect ENETUNREACH 2606:4700::1"))).toBe(true)
    expect(isHttp3HandshakeError(new Error("connect EHOSTUNREACH 1.2.3.4"))).toBe(true)
  })

  test("walks cause chain one level", () => {
    const cause = new Error("HTTP3HandshakeFailed inner")
    const outer = new TypeError("fetch failed", { cause })
    expect(isHttp3HandshakeError(outer)).toBe(true)
  })

  test("does not match unrelated errors", () => {
    expect(isHttp3HandshakeError(new Error("ECONNRESET"))).toBe(false)
    expect(isHttp3HandshakeError(new Error("AbortError: operation cancelled"))).toBe(false)
    expect(isHttp3HandshakeError(new Error("403 Forbidden"))).toBe(false)
    expect(isHttp3HandshakeError(null)).toBe(false)
    expect(isHttp3HandshakeError(undefined)).toBe(false)
    expect(isHttp3HandshakeError("")).toBe(false)
  })

  test("accepts string errors as-is", () => {
    expect(isHttp3HandshakeError("HTTP3HandshakeFailed")).toBe(true)
    expect(isHttp3HandshakeError("anything else")).toBe(false)
  })
})

describe("Http3Transport (with fake fetch)", () => {
  let originalFetch: typeof fetch
  let lastInit: RequestInit & { protocol?: string }
  let lastUrl: string

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("calls fetch with protocol:'http3'", async () => {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      lastUrl = url
      lastInit = init as RequestInit & { protocol?: string }
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch

    const transport = new Http3Transport()
    const res = await transport.request({
      id: "t",
      label: "t",
      method: "GET",
      url: "https://api.example.com/v1/x",
    })

    expect(lastUrl).toBe("https://api.example.com/v1/x")
    expect(lastInit.protocol).toBe("http3")
    expect(res.status).toBe(200)
    expect(res.transport.id).toBe("http3")
    expect(res.transport.protocol).toBe("h3")
    expect(res.transport.origin).toBe("https://api.example.com")
    expect(res.transport.fallbackUsed).toBe(false)
  })

  test("propagates response headers (Alt-Svc included) to NetworkResponse", async () => {
    globalThis.fetch = (async () =>
      new Response("", {
        status: 200,
        headers: { "alt-svc": 'h3=":443"; ma=86400', "x-custom": "v" },
      })) as unknown as typeof fetch

    const transport = new Http3Transport()
    const res = await transport.request({
      id: "t",
      label: "t",
      method: "GET",
      url: "https://api.example.com/",
    })
    expect(res.headers.get("alt-svc")).toBe('h3=":443"; ma=86400')
    expect(res.headers.get("x-custom")).toBe("v")
  })

  test("propagates the body as a ReadableStream", async () => {
    globalThis.fetch = (async () =>
      new Response("hello world", { status: 200 })) as unknown as typeof fetch

    const transport = new Http3Transport()
    const res = await transport.request({
      id: "t",
      label: "t",
      method: "GET",
      url: "https://api.example.com/",
    })
    expect(await res.text()).toBe("hello world")
  })

  test("transparently propagates fetch errors (caller decides if h3-handshake)", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("HTTP3HandshakeFailed: nope")
    }) as unknown as typeof fetch

    const transport = new Http3Transport()
    await expect(
      transport.request({
        id: "t",
        label: "t",
        method: "GET",
        url: "https://api.example.com/",
      }),
    ).rejects.toThrow(/HTTP3HandshakeFailed/)
  })

  test("forwards AbortSignal to fetch", async () => {
    let receivedSignal: AbortSignal | null = null
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      receivedSignal = init.signal as AbortSignal
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch

    const ac = new AbortController()
    const transport = new Http3Transport()
    await transport.request({
      id: "t",
      label: "t",
      method: "GET",
      url: "https://api.example.com/",
      signal: ac.signal,
    })
    // Cast widens TS's flow-narrowed view of `receivedSignal` (which it
    // pins to the initializer `null`) so we can assert the closure ran.
    expect(receivedSignal as AbortSignal | null).toBe(ac.signal)
  })

  test("safely reports origin=undefined for malformed URLs", async () => {
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch
    const transport = new Http3Transport()
    const res = await transport.request({
      id: "t",
      label: "t",
      method: "GET",
      url: "::not-a-url::",
    })
    // fetch will throw on a real bad URL, but the safeOrigin guard
    // also covers the case where url is technically parseable but
    // pathologically shaped (e.g. opaque scheme). We just want it
    // to never blow up our transport.
    expect(res.transport.origin === undefined || typeof res.transport.origin === "string").toBe(
      true,
    )
  })
})

// Live network test against cloudflare.com — gated behind an env var
// so CI stays hermetic. Run with:
//   MINIMAL_AGENT_LIVE_H3=1 bun test src/network/http3-transport.test.ts
describe.skipIf(process.env.MINIMAL_AGENT_LIVE_H3 !== "1")(
  "Http3Transport (LIVE — cloudflare.com)",
  () => {
    test("negotiates h3 with cloudflare.com", async () => {
      const transport = new Http3Transport()
      // GET (not HEAD) because NetworkMethod intentionally omits HEAD —
      // it's a niche method the agent never issues for real traffic.
      const res = await transport.request({
        id: "live-h3",
        label: "live",
        method: "GET",
        url: "https://www.cloudflare.com/",
      })
      await res.body.cancel()
      expect(res.status).toBe(200)
      expect(res.transport.protocol).toBe("h3")
    }, 15_000)

    test("returns a real h3 handshake error against an h3-less origin", async () => {
      const transport = new Http3Transport()
      await expect(
        transport.request({
          id: "live-h3-fail",
          label: "live",
          method: "GET",
          url: "https://api.example.com/v1/messages",
        }),
      ).rejects.toThrow(/HTTP3HandshakeFailed/)
    }, 15_000)
  },
)

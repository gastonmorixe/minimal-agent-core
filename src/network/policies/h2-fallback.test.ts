import { EventEmitter } from "node:events"
import type { ClientHttp2Session } from "node:http2"

import { describe, expect, test } from "bun:test"

import { NetworkClient } from "../client.ts"
import { Http2FallbackCache } from "../http2-fallback-cache.ts"
import { _waitForSessionForTest, isHttp2UnsupportedError } from "../http2-transport.ts"
import type { NetworkRequest, NetworkResponse, NetworkTransport } from "../types.ts"

import { type H2FallbackDecisionEvent, http2FallbackPolicy } from "./h2-fallback.ts"

// ── Test helpers ─────────────────────────────────────────────────────────

/**
 * Tracking transport: records every request it sees so we can assert on
 * routing / call counts. `respond` lets the test decide what each call
 * returns (or throws). Default = empty 200.
 */
class TracingTransport implements NetworkTransport {
  readonly id: string
  readonly calls: NetworkRequest[] = []
  respond: (req: NetworkRequest) => Promise<NetworkResponse>

  constructor(id: string, respond?: (req: NetworkRequest) => Promise<NetworkResponse>) {
    this.id = id
    this.respond = respond ?? (async () => makeResponse(this.id))
  }

  async request(req: NetworkRequest): Promise<NetworkResponse> {
    this.calls.push(req)
    return this.respond(req)
  }
}

function makeResponse(transportId: string, status = 200, body = ""): NetworkResponse {
  return {
    status,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (body) controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
    transport: {
      id: transportId,
      protocol: transportId === "http2" ? "h2" : "http/1.1",
      origin: undefined,
      reused: undefined,
      fallbackUsed: false,
    },
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async () => JSON.parse(body),
    // biome-ignore lint/suspicious/noExplicitAny: shape-only test stub
  } as any
}

function h2UnsupportedError(): Error & { code: string } {
  const err = new Error("h2 is not supported") as Error & { code: string }
  err.code = "ERR_HTTP2_ERROR"
  return err
}

/** A `ClientHttp2Session`-shaped EventEmitter for `_waitForSessionForTest`. */
class FakeHttp2Session extends EventEmitter {
  closed = false
  destroyed = false
  alpnProtocol: string | undefined
  socket: unknown = undefined

  constructor() {
    super()
    // node:events throws on an "error" emission with zero listeners. A real
    // ClientHttp2Session always has at least one (the transport's own
    // teardown listener), so this baseline no-op keeps the fake from
    // crashing on EV-4's SECOND error event, once `waitForSession`'s own
    // `.once()` listener has already consumed the first and removed itself
    // — exactly the scenario this fake exists to reproduce.
    this.on("error", () => {})
  }
}

// ── isHttp2UnsupportedError (classifier) ─────────────────────────────────

describe("isHttp2UnsupportedError", () => {
  test("matches Bun's raw connect-phase error (EV-4)", () => {
    expect(isHttp2UnsupportedError(h2UnsupportedError())).toBe(true)
  })

  test("matches this transport's own ALPN-mismatch message", () => {
    expect(
      isHttp2UnsupportedError(new Error("HTTP/2 ALPN negotiation failed for https://x: http/1.1")),
    ).toBe(true)
  })

  test("does not match an unrelated transient error", () => {
    expect(isHttp2UnsupportedError(new Error("ECONNRESET"))).toBe(false)
  })

  test("does not match a connect timeout", () => {
    expect(isHttp2UnsupportedError(new Error("HTTP/2 connect timeout for https://x"))).toBe(false)
  })

  test("false for non-error / null input", () => {
    expect(isHttp2UnsupportedError(null)).toBe(false)
    expect(isHttp2UnsupportedError(undefined)).toBe(false)
    expect(isHttp2UnsupportedError("plain string")).toBe(false)
  })
})

// ── waitForSession: the exact EV-4 event sequence ────────────────────────

describe("waitForSession — EV-4 event ordering (Bun 1.4.4 h2-unsupported origin)", () => {
  test("rejects with the FIRST error event; later connect/error are ignored", async () => {
    const session = new FakeHttp2Session()
    const promise = _waitForSessionForTest(
      session as unknown as ClientHttp2Session,
      "https://h1only.example.com",
      5_000,
    )

    // EV-4's observed order: error, then connect (alpnProtocol lies "h2"),
    // then a second error ("Protocol error"). The real failure is the
    // first event — `waitForSession` uses `.once()`, so it must settle on
    // that one and never consult `alpnProtocol` on this path at all.
    session.emit("error", h2UnsupportedError())
    session.alpnProtocol = "h2" // EV-4: this is wrong for this origin — must not be trusted
    session.emit("connect")
    session.emit("error", new Error("Protocol error"))

    let caught: unknown
    try {
      await promise
    } catch (err) {
      caught = err
    }
    expect((caught as Error)?.message).toBe("h2 is not supported")
    expect(isHttp2UnsupportedError(caught)).toBe(true)
  })

  test("resolves on a clean connect with the correct alpnProtocol", async () => {
    const session = new FakeHttp2Session()
    const promise = _waitForSessionForTest(
      session as unknown as ClientHttp2Session,
      "https://api.example.com",
      5_000,
    )
    session.alpnProtocol = "h2"
    session.emit("connect")
    await expect(promise).resolves.toBeUndefined()
  })
})

// ── Http2FallbackCache ────────────────────────────────────────────────────

describe("Http2FallbackCache", () => {
  test("unknown origin reads as not h1-only", () => {
    const cache = new Http2FallbackCache()
    expect(cache.isH1Only("https://h1only.example.com")).toBe(false)
  })

  test("markH1Only is remembered and normalizes the origin", () => {
    const cache = new Http2FallbackCache()
    cache.markH1Only("https://h1only.example.com/v1/chat/completions")
    expect(cache.isH1Only("https://h1only.example.com")).toBe(true)
    expect(cache.isH1Only("https://h1only.example.com/some/other/path")).toBe(true)
  })

  test("malformed origin is a no-op, never throws", () => {
    const cache = new Http2FallbackCache()
    expect(() => cache.markH1Only("::not-a-url::")).not.toThrow()
    expect(cache.isH1Only("::not-a-url::")).toBe(false)
  })

  test("clear empties the cache and returns the removed count", () => {
    const cache = new Http2FallbackCache()
    cache.markH1Only("https://a.example.com")
    cache.markH1Only("https://b.example.com")
    expect(cache.size()).toBe(2)
    expect(cache.clear()).toBe(2)
    expect(cache.size()).toBe(0)
  })

  test("enforces maxSize by evicting the oldest entry", () => {
    const cache = new Http2FallbackCache({ maxSize: 2 })
    cache.markH1Only("https://a.example.com")
    cache.markH1Only("https://b.example.com")
    cache.markH1Only("https://c.example.com")
    expect(cache.size()).toBe(2)
    expect(cache.isH1Only("https://a.example.com")).toBe(false)
    expect(cache.isH1Only("https://c.example.com")).toBe(true)
  })
})

// ── http2FallbackPolicy — onRequest ──────────────────────────────────────

describe("http2FallbackPolicy — onRequest", () => {
  test("pass-through when cache has no verdict for this origin", async () => {
    const cache = new Http2FallbackCache()
    const policy = http2FallbackPolicy({ cache })
    const out = await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "https://h1only.example.com/x",
    })
    expect(out).toBeUndefined()
  })

  test("pins protocol='http/1.1' once the cache says this origin is h1-only", async () => {
    const cache = new Http2FallbackCache()
    cache.markH1Only("https://h1only.example.com")
    const policy = http2FallbackPolicy({ cache })
    const out = await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "https://h1only.example.com/x",
    })
    expect(out?.protocol).toBe("http/1.1")
  })

  test("respects a caller-set protocol pin, including an explicit h2 pin", async () => {
    const cache = new Http2FallbackCache()
    cache.markH1Only("https://h1only.example.com")
    const policy = http2FallbackPolicy({ cache })
    const out = await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "https://h1only.example.com/x",
      protocol: "h2", // caller pinned — keeps the Cursor Connect rule
    })
    expect(out).toBeUndefined()
  })

  test("invalid URL is a no-op (does not throw)", async () => {
    const cache = new Http2FallbackCache()
    const policy = http2FallbackPolicy({ cache })
    const out = await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "::not-a-url::",
    })
    expect(out).toBeUndefined()
  })

  test("emits onDecision(kind: 'skip-h2') on a cache-hit pin", async () => {
    const cache = new Http2FallbackCache()
    cache.markH1Only("https://h1only.example.com")
    const events: H2FallbackDecisionEvent[] = []
    const policy = http2FallbackPolicy({ cache, onDecision: (e) => events.push(e) })
    await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "https://h1only.example.com/x",
    })
    expect(events).toEqual([{ origin: "https://h1only.example.com", kind: "skip-h2" }])
  })
})

// ── http2FallbackPolicy — wrap ────────────────────────────────────────────

describe("http2FallbackPolicy — wrap", () => {
  test("AT-1: h2-unsupported failure serves the request on fetch and marks the cache", async () => {
    const cache = new Http2FallbackCache()
    const policy = http2FallbackPolicy({ cache })

    let runCalls = 0
    let lastOverride: NetworkRequest | undefined
    const run = async (override?: NetworkRequest): Promise<NetworkResponse> => {
      runCalls++
      lastOverride = override
      if (runCalls === 1) throw h2UnsupportedError()
      return makeResponse("fetch", 200, "served")
    }

    const res = await policy.wrap!(
      { id: "1", label: "t", method: "GET", url: "https://h1only.example.com/x" },
      run,
    )

    expect(runCalls).toBe(2) // served on the SECOND (fetch) attempt, not just learned-and-thrown
    expect(lastOverride?.protocol).toBe("http/1.1")
    expect(await res.text()).toBe("served")
    expect(cache.isH1Only("https://h1only.example.com")).toBe(true)
  })

  test("AT-3: an explicit protocol='h2' pin propagates the error, no fallback, no cache write", async () => {
    const cache = new Http2FallbackCache()
    const policy = http2FallbackPolicy({ cache })

    let runCalls = 0
    const run = async (): Promise<NetworkResponse> => {
      runCalls++
      throw h2UnsupportedError()
    }

    await expect(
      policy.wrap!(
        {
          id: "1",
          label: "t",
          method: "GET",
          url: "https://h1only.example.com/x",
          protocol: "h2",
        },
        run,
      ),
    ).rejects.toThrow(/h2 is not supported/)
    expect(runCalls).toBe(1)
    expect(cache.isH1Only("https://h1only.example.com")).toBe(false)
  })

  test("a request-level allowFetchFallback:false opt-out also skips the fallback", async () => {
    const cache = new Http2FallbackCache()
    const policy = http2FallbackPolicy({ cache })

    let runCalls = 0
    const run = async (): Promise<NetworkResponse> => {
      runCalls++
      throw h2UnsupportedError()
    }

    await expect(
      policy.wrap!(
        {
          id: "1",
          label: "t",
          method: "GET",
          url: "https://h1only.example.com/x",
          allowFetchFallback: false,
        },
        run,
      ),
    ).rejects.toThrow(/h2 is not supported/)
    expect(runCalls).toBe(1)
    expect(cache.isH1Only("https://h1only.example.com")).toBe(false)
  })

  test("non h2-unsupported errors propagate without retry or cache write", async () => {
    const cache = new Http2FallbackCache()
    const policy = http2FallbackPolicy({ cache })

    let runCalls = 0
    const run = async (): Promise<NetworkResponse> => {
      runCalls++
      throw new Error("ECONNRESET")
    }

    await expect(
      policy.wrap!(
        { id: "1", label: "t", method: "GET", url: "https://h1only.example.com/x" },
        run,
      ),
    ).rejects.toThrow(/ECONNRESET/)
    expect(runCalls).toBe(1)
    expect(cache.isH1Only("https://h1only.example.com")).toBe(false)
  })
})

// ── End-to-end: NetworkClient + policy + tracing transports ──────────────

describe("NetworkClient + http2FallbackPolicy integration", () => {
  test("AT-1: first request to an h2-unsupported origin is still served (via fetch)", async () => {
    const cache = new Http2FallbackCache()
    const h2 = new TracingTransport("http2", async () => {
      throw h2UnsupportedError()
    })
    const fetchT = new TracingTransport("fetch")
    const client = new NetworkClient({
      primary: h2,
      transports: new Map([["http/1.1", fetchT]]),
      policies: [http2FallbackPolicy({ cache })],
    })

    const res = await client.request({
      label: "t",
      method: "GET",
      url: "https://h1only.example.com/x",
    })
    expect(res.transport.id).toBe("fetch")
    expect(h2.calls).toHaveLength(1)
    expect(fetchT.calls).toHaveLength(1)
    expect(cache.isH1Only("https://h1only.example.com")).toBe(true)
  })

  test("AT-2: a second request to the same origin skips h2 entirely (cache hit)", async () => {
    const cache = new Http2FallbackCache()
    let h2CallCount = 0
    const h2 = new TracingTransport("http2", async () => {
      h2CallCount++
      throw h2UnsupportedError()
    })
    const fetchT = new TracingTransport("fetch")
    const client = new NetworkClient({
      primary: h2,
      transports: new Map([["http/1.1", fetchT]]),
      policies: [http2FallbackPolicy({ cache })],
    })

    const r1 = await client.request({
      label: "t",
      method: "GET",
      url: "https://h1only.example.com/a",
    })
    const r2 = await client.request({
      label: "t",
      method: "GET",
      url: "https://h1only.example.com/b",
    })
    const r3 = await client.request({
      label: "t",
      method: "GET",
      url: "https://h1only.example.com/c",
    })

    expect(h2CallCount).toBe(1) // only the first request ever tried h2
    expect(r1.transport.id).toBe("fetch")
    expect(r2.transport.id).toBe("fetch")
    expect(r3.transport.id).toBe("fetch")
    expect(fetchT.calls).toHaveLength(3)
  })

  test("AT-3: an explicit protocol:'h2' pin still fails with no fallback (Cursor Connect rule)", async () => {
    const cache = new Http2FallbackCache()
    cache.markH1Only("https://h1only.example.com") // even with a learned verdict already cached
    const h2 = new TracingTransport("http2", async () => {
      throw h2UnsupportedError()
    })
    const fetchT = new TracingTransport("fetch")
    const client = new NetworkClient({
      primary: h2,
      transports: new Map([
        ["h2", h2],
        ["http/1.1", fetchT],
      ]),
      policies: [http2FallbackPolicy({ cache })],
    })

    await expect(
      client.request({
        label: "t",
        method: "GET",
        url: "https://h1only.example.com/x",
        protocol: "h2",
      }),
    ).rejects.toThrow(/h2 is not supported/)
    expect(fetchT.calls).toHaveLength(0)
  })

  test("is independent of allowFetchFallback (fires even when that flag is off/default)", async () => {
    const cache = new Http2FallbackCache()
    const h2 = new TracingTransport("http2", async () => {
      throw h2UnsupportedError()
    })
    const fetchT = new TracingTransport("fetch")
    const client = new NetworkClient({
      primary: h2,
      // allowFetchFallback intentionally omitted — defaults to false
      transports: new Map([["http/1.1", fetchT]]),
      policies: [http2FallbackPolicy({ cache })],
    })

    const res = await client.request({
      label: "t",
      method: "GET",
      url: "https://h1only.example.com/x",
    })
    expect(res.transport.id).toBe("fetch")
  })

  test("transport map miss for 'http/1.1' leaves the original error uncaught (no transport to retry on)", async () => {
    const cache = new Http2FallbackCache()
    const h2 = new TracingTransport("http2", async () => {
      throw h2UnsupportedError()
    })
    // No "http/1.1" entry registered — simulates a client built without the
    // fetch transport wired in.
    const client = new NetworkClient({
      primary: h2,
      policies: [http2FallbackPolicy({ cache })],
    })

    await expect(
      client.request({ label: "t", method: "GET", url: "https://h1only.example.com/x" }),
    ).rejects.toThrow(/h2 is not supported/)
    // The cache still learns from the failure even though this request
    // couldn't be served — a later client with the transport wired in
    // benefits immediately.
    expect(cache.isH1Only("https://h1only.example.com")).toBe(true)
  })
})

// ── Telemetry: fallbackUsed must be true after an ALPN downgrade ─────────
// IMPROVEMENTS.md items 1 + 22. Regression guard: the policy retry SUCCEEDS,
// so the error never reaches NetworkClient's outer fallback branch, which is
// the only other place that sets `fallbackUsed`. Before the fix, a genuine
// h2→http/1.1 downgrade reported `fallbackUsed:false`.

describe("http2FallbackPolicy — fallback telemetry (items 1 + 22)", () => {
  /** Minimal ALPN-refusing h2 transport: fails exactly like the real one. */
  function h2RefusingTransport(): TracingTransport {
    return new TracingTransport("http2", async () => {
      throw new Error("HTTP/2 ALPN negotiation failed for https://h1only.example.com: http/1.1")
    })
  }

  test("ALPN refusal → fallbackUsed:true and protocol 'http/1.1' (no outer fallback configured)", async () => {
    const cache = new Http2FallbackCache()
    const h2 = h2RefusingTransport()
    const fetchT = new TracingTransport("fetch")
    // NOTE: no `fallback` option — the outer NetworkClient fallback branch
    // cannot fire here, so only the policy path can set the flag.
    const client = new NetworkClient({
      primary: h2,
      transports: new Map([["http/1.1", fetchT]]),
      policies: [http2FallbackPolicy({ cache })],
    })

    const res = await client.request({
      label: "t",
      method: "GET",
      url: "https://h1only.example.com/x",
    })

    expect(res.transport.id).toBe("fetch")
    expect(res.transport.protocol).toBe("http/1.1")
    expect(res.transport.fallbackUsed).toBe(true)
    expect(h2.calls).toHaveLength(1)
    expect(fetchT.calls).toHaveLength(1)
  })

  test("a cache-hit pin from onRequest is NOT a fallback (nothing was attempted)", async () => {
    const cache = new Http2FallbackCache()
    cache.markH1Only("https://h1only.example.com")
    const h2 = new TracingTransport("http2")
    const fetchT = new TracingTransport("fetch")
    const client = new NetworkClient({
      primary: h2,
      transports: new Map([["http/1.1", fetchT]]),
      policies: [http2FallbackPolicy({ cache })],
    })

    const res = await client.request({
      label: "t",
      method: "GET",
      url: "https://h1only.example.com/x",
    })

    expect(res.transport.id).toBe("fetch")
    expect(res.transport.fallbackUsed).toBe(false)
    expect(h2.calls).toHaveLength(0)
    expect(fetchT.calls).toHaveLength(1)
  })

  test("a caller-pinned 'http/1.1' request is NOT a fallback", async () => {
    const cache = new Http2FallbackCache()
    const h2 = new TracingTransport("http2")
    const fetchT = new TracingTransport("fetch")
    const client = new NetworkClient({
      primary: h2,
      transports: new Map([["http/1.1", fetchT]]),
      policies: [http2FallbackPolicy({ cache })],
    })

    const res = await client.request({
      label: "t",
      method: "GET",
      url: "https://h1only.example.com/x",
      protocol: "http/1.1",
    })

    expect(res.transport.fallbackUsed).toBe(false)
    expect(h2.calls).toHaveLength(0)
  })

  test("an h2 pin that fails keeps fallbackUsed unset (error propagates, nothing served)", async () => {
    const cache = new Http2FallbackCache()
    const fetchT = new TracingTransport("fetch")
    const client = new NetworkClient({
      primary: h2RefusingTransport(),
      transports: new Map([["http/1.1", fetchT]]),
      policies: [http2FallbackPolicy({ cache })],
    })

    await expect(
      client.request({
        label: "t",
        method: "GET",
        url: "https://h1only.example.com/x",
        protocol: "h2",
      }),
    ).rejects.toThrow(/ALPN negotiation failed/)
    expect(fetchT.calls).toHaveLength(0)
  })
})

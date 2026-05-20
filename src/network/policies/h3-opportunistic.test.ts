import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { NetworkClient } from "../client.ts"
import { Http3NegotiationCache } from "../http3-cache.ts"
import type { NetworkRequest, NetworkResponse, NetworkTransport } from "../types.ts"
import { type H3DecisionEvent, http3OpportunisticPolicy } from "./h3-opportunistic.ts"

// ── Test helpers ─────────────────────────────────────────────────────────

/**
 * Tracking transport: records every request it sees so we can assert on
 * routing. `respond` lets the test decide what each call returns (or
 * throws). Default = empty 200.
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

function makeResponse(
  transportId: string,
  status = 200,
  headers: Record<string, string> = {},
): NetworkResponse {
  // Build a NetworkResponse-shaped object without importing from types
  // again (simulates what a real transport returns).
  return {
    status,
    headers: new Headers(headers),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    }),
    transport: {
      id: transportId,
      protocol: transportId === "http3" ? "h3" : transportId === "http2" ? "h2" : "http/1.1",
      origin: undefined,
      reused: undefined,
      fallbackUsed: false,
    },
    ok: status >= 200 && status < 300,
    text: async () => "",
    json: async () => ({}),
    // biome-ignore lint/suspicious/noExplicitAny: shape-only test stub
  } as any
}

// ── onRequest behavior ───────────────────────────────────────────────────

describe("http3OpportunisticPolicy — onRequest", () => {
  test("pass-through when cache verdict is 'unknown'", async () => {
    const cache = new Http3NegotiationCache()
    const policy = http3OpportunisticPolicy({ cache })
    const out = await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "https://api.example.com/x",
    })
    expect(out).toBeUndefined() // no protocol mutation
  })

  test("pins protocol='h3' when cache says 'supported'", async () => {
    const cache = new Http3NegotiationCache()
    cache.seed("https://api.example.com", "supported")
    const policy = http3OpportunisticPolicy({ cache })
    const out = await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "https://api.example.com/x",
    })
    expect(out?.protocol).toBe("h3")
  })

  test("does NOT pin when cache says 'unsupported' (in opt mode)", async () => {
    const cache = new Http3NegotiationCache()
    cache.seed("https://api.example.com", "unsupported")
    const policy = http3OpportunisticPolicy({ cache })
    const out = await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "https://api.example.com/x",
    })
    expect(out).toBeUndefined()
  })

  test("respects caller-set protocol (does not overwrite)", async () => {
    const cache = new Http3NegotiationCache()
    cache.seed("https://api.example.com", "supported")
    const policy = http3OpportunisticPolicy({ cache })
    const out = await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "https://api.example.com/x",
      protocol: "h2", // caller pinned
    })
    expect(out).toBeUndefined() // policy backed off
  })

  test("force mode pins h3 for 'unknown' origins too", async () => {
    const cache = new Http3NegotiationCache()
    const policy = http3OpportunisticPolicy({ cache, mode: "force" })
    const out = await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "https://api.example.com/x",
    })
    expect(out?.protocol).toBe("h3")
  })

  test("force mode still backs off for 'unsupported' origins", async () => {
    const cache = new Http3NegotiationCache()
    cache.seed("https://api.example.com", "unsupported")
    const policy = http3OpportunisticPolicy({ cache, mode: "force" })
    const out = await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "https://api.example.com/x",
    })
    expect(out).toBeUndefined()
  })

  test("invalid URL is a no-op (does not throw)", async () => {
    const cache = new Http3NegotiationCache()
    const policy = http3OpportunisticPolicy({ cache })
    const out = await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "::not-a-url::",
    })
    expect(out).toBeUndefined()
  })

  test("emits onDecision event with kind/verdict/callerPinned", async () => {
    const cache = new Http3NegotiationCache()
    cache.seed("https://api.example.com", "supported")
    const events: H3DecisionEvent[] = []
    const policy = http3OpportunisticPolicy({
      cache,
      onDecision: (e) => events.push(e),
    })
    await policy.onRequest!({
      id: "1",
      label: "t",
      method: "GET",
      url: "https://api.example.com/x",
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      origin: "https://api.example.com",
      kind: "pin-h3",
      verdict: "supported",
      callerPinned: false,
    })
  })
})

// ── onResponse behavior ──────────────────────────────────────────────────

describe("http3OpportunisticPolicy — onResponse", () => {
  test("records alt-svc h3 advertisement into the cache", async () => {
    const cache = new Http3NegotiationCache()
    const policy = http3OpportunisticPolicy({ cache })
    expect(cache.lookup("https://api.example.com")).toBe("unknown")
    await policy.onResponse!(
      {
        id: "1",
        label: "t",
        method: "GET",
        url: "https://api.example.com/x",
      },
      makeResponse("http2", 200, { "alt-svc": 'h3=":443"; ma=86400' }),
      // dummy retry — unused here
      async () => makeResponse("http2"),
    )
    expect(cache.lookup("https://api.example.com")).toBe("supported")
  })

  test("ignores responses without alt-svc", async () => {
    const cache = new Http3NegotiationCache()
    const policy = http3OpportunisticPolicy({ cache })
    await policy.onResponse!(
      {
        id: "1",
        label: "t",
        method: "GET",
        url: "https://api.example.com/x",
      },
      makeResponse("http2"),
      async () => makeResponse("http2"),
    )
    expect(cache.lookup("https://api.example.com")).toBe("unknown")
  })

  test("returns undefined (no response substitution)", async () => {
    const cache = new Http3NegotiationCache()
    const policy = http3OpportunisticPolicy({ cache })
    const out = await policy.onResponse!(
      {
        id: "1",
        label: "t",
        method: "GET",
        url: "https://api.example.com/x",
      },
      makeResponse("http2"),
      async () => makeResponse("http2"),
    )
    expect(out).toBeUndefined()
  })
})

// ── wrap behavior: h3 handshake failure → downgrade-retry ────────────────

describe("http3OpportunisticPolicy — wrap (h3 → h2 downgrade)", () => {
  test("on handshake failure, marks cache and retries with override", async () => {
    const cache = new Http3NegotiationCache()
    const policy = http3OpportunisticPolicy({ cache })

    let runCalls = 0
    let lastOverride: NetworkRequest | undefined
    const run = async (override?: NetworkRequest): Promise<NetworkResponse> => {
      runCalls++
      lastOverride = override
      if (runCalls === 1) {
        throw new TypeError("HTTP3HandshakeFailed: nope")
      }
      return makeResponse("http2")
    }

    const res = await policy.wrap!(
      {
        id: "1",
        label: "t",
        method: "GET",
        url: "https://api.example.com/x",
        protocol: "h3", // pinned by an earlier onRequest pass
      },
      run,
    )

    expect(runCalls).toBe(2)
    expect(lastOverride?.protocol).toBeUndefined()
    expect(res.transport.id).toBe("http2")
    expect(cache.lookup("https://api.example.com")).toBe("unsupported")
  })

  test("non-handshake errors propagate without retry", async () => {
    const cache = new Http3NegotiationCache()
    const policy = http3OpportunisticPolicy({ cache })

    let runCalls = 0
    const run = async (): Promise<NetworkResponse> => {
      runCalls++
      throw new Error("ECONNRESET")
    }

    await expect(
      policy.wrap!(
        {
          id: "1",
          label: "t",
          method: "GET",
          url: "https://api.example.com/x",
          protocol: "h3",
        },
        run,
      ),
    ).rejects.toThrow(/ECONNRESET/)
    expect(runCalls).toBe(1)
    // network errors do NOT cache a verdict
    expect(cache.lookup("https://api.example.com")).toBe("unknown")
  })

  test("non-h3 requests bypass the downgrade path entirely", async () => {
    const cache = new Http3NegotiationCache()
    const policy = http3OpportunisticPolicy({ cache })

    let runCalls = 0
    const run = async (): Promise<NetworkResponse> => {
      runCalls++
      throw new TypeError("HTTP3HandshakeFailed: somehow") // shouldn't matter
    }

    await expect(
      policy.wrap!(
        {
          id: "1",
          label: "t",
          method: "GET",
          url: "https://api.example.com/x",
          // no protocol — caller didn't ask for h3
        },
        run,
      ),
    ).rejects.toThrow(/HTTP3HandshakeFailed/)
    expect(runCalls).toBe(1)
  })

  test("caller-pinned h3 (explicit-h3 tag) is surfaced unchanged", async () => {
    const cache = new Http3NegotiationCache()
    const policy = http3OpportunisticPolicy({ cache })

    let runCalls = 0
    const run = async (): Promise<NetworkResponse> => {
      runCalls++
      throw new TypeError("HTTP3HandshakeFailed: nope")
    }

    await expect(
      policy.wrap!(
        {
          id: "1",
          label: "t",
          method: "GET",
          url: "https://api.example.com/x",
          protocol: "h3",
          policyTags: ["explicit-h3"], // caller said "I want h3 specifically"
        },
        run,
      ),
    ).rejects.toThrow(/HTTP3HandshakeFailed/)
    expect(runCalls).toBe(1)
    // cache STILL records the failure for future opportunistic decisions
    expect(cache.lookup("https://api.example.com")).toBe("unsupported")
  })
})

// ── End-to-end: NetworkClient + policy + tracing transports ──────────────

describe("NetworkClient + http3OpportunisticPolicy integration", () => {
  test("first request goes to primary h2, second goes to h3 after alt-svc", async () => {
    const cache = new Http3NegotiationCache()
    const h2 = new TracingTransport("http2", async () =>
      makeResponse("http2", 200, { "alt-svc": 'h3=":443"; ma=86400' }),
    )
    const h3 = new TracingTransport("http3")
    const client = new NetworkClient({
      primary: h2,
      transports: new Map([["h3", h3]]),
      policies: [http3OpportunisticPolicy({ cache })],
    })

    const r1 = await client.request({
      label: "t",
      method: "GET",
      url: "https://api.example.com/x",
    })
    expect(r1.transport.id).toBe("http2")
    expect(h2.calls).toHaveLength(1)
    expect(h3.calls).toHaveLength(0)
    expect(cache.lookup("https://api.example.com")).toBe("supported")

    const r2 = await client.request({
      label: "t",
      method: "GET",
      url: "https://api.example.com/y",
    })
    expect(r2.transport.id).toBe("http3")
    expect(h2.calls).toHaveLength(1)
    expect(h3.calls).toHaveLength(1)
  })

  test("h3 handshake failure downgrades to h2 transparently AND caches verdict", async () => {
    const cache = new Http3NegotiationCache()
    cache.seed("https://api.example.com", "supported") // policy will pin h3
    const h2 = new TracingTransport("http2")
    const h3 = new TracingTransport("http3", async () => {
      throw new TypeError("HTTP3HandshakeFailed: nope")
    })
    const client = new NetworkClient({
      primary: h2,
      transports: new Map([["h3", h3]]),
      policies: [http3OpportunisticPolicy({ cache })],
    })

    const r = await client.request({
      label: "t",
      method: "GET",
      url: "https://api.example.com/x",
    })
    expect(r.transport.id).toBe("http2") // downgraded
    expect(h3.calls).toHaveLength(1)
    expect(h2.calls).toHaveLength(1)
    expect(cache.lookup("https://api.example.com")).toBe("unsupported")
  })

  test("subsequent requests after downgrade go straight to h2 (cache hit)", async () => {
    const cache = new Http3NegotiationCache()
    cache.seed("https://api.example.com", "supported")
    const h2 = new TracingTransport("http2")
    let h3CallCount = 0
    const h3 = new TracingTransport("http3", async () => {
      h3CallCount++
      throw new TypeError("HTTP3HandshakeFailed: nope")
    })
    const client = new NetworkClient({
      primary: h2,
      transports: new Map([["h3", h3]]),
      policies: [http3OpportunisticPolicy({ cache })],
    })

    await client.request({ label: "t", method: "GET", url: "https://api.example.com/a" })
    await client.request({ label: "t", method: "GET", url: "https://api.example.com/b" })
    await client.request({ label: "t", method: "GET", url: "https://api.example.com/c" })

    expect(h3CallCount).toBe(1) // only the first request tried h3
    expect(h2.calls).toHaveLength(3) // all three resolved via h2
  })

  test("caller-pinned protocol routes directly to that transport, no policy override", async () => {
    const cache = new Http3NegotiationCache()
    cache.seed("https://api.example.com", "unsupported") // policy would say no
    const h2 = new TracingTransport("http2")
    const h3 = new TracingTransport("http3")
    const client = new NetworkClient({
      primary: h2,
      transports: new Map([["h3", h3]]),
      policies: [http3OpportunisticPolicy({ cache })],
    })

    const r = await client.request({
      label: "t",
      method: "GET",
      url: "https://api.example.com/x",
      protocol: "h3", // caller forced it
    })
    expect(r.transport.id).toBe("http3")
    expect(h3.calls).toHaveLength(1)
    expect(h2.calls).toHaveLength(0)
  })

  test("transport map miss for req.protocol gracefully falls back to primary", async () => {
    const cache = new Http3NegotiationCache()
    cache.seed("https://api.example.com", "supported")
    const h2 = new TracingTransport("http2")
    // h3 NOT registered — simulates user with MINIMAL_AGENT_HTTP3 off
    const client = new NetworkClient({
      primary: h2,
      policies: [http3OpportunisticPolicy({ cache })],
    })

    const r = await client.request({
      label: "t",
      method: "GET",
      url: "https://api.example.com/x",
    })
    // policy DID rewrite to h3, but transport map miss → primary
    expect(r.transport.id).toBe("http2")
    expect(h2.calls).toHaveLength(1)
    expect(h2.calls[0]?.protocol).toBe("h3") // proves the rewrite ran
  })
})

// ── No-policy regression — preserves legacy two-arg constructor flow ─────

describe("NetworkClient back-compat: no policies + no transports map", () => {
  test("legacy primary/fallback flow is unchanged", async () => {
    const h2 = new TracingTransport("http2")
    const client = new NetworkClient({ primary: h2 })
    await client.request({ label: "t", method: "GET", url: "https://api.example.com/x" })
    expect(h2.calls).toHaveLength(1)
  })

  test("legacy fetch fallback still triggers", async () => {
    let primaryCalled = 0
    let fallbackCalled = 0
    const primary: NetworkTransport = {
      id: "broken",
      async request() {
        primaryCalled++
        throw new Error("primary down")
      },
    }
    const fallback: NetworkTransport = {
      id: "fetch",
      async request() {
        fallbackCalled++
        return makeResponse("fetch")
      },
    }
    const client = new NetworkClient({
      primary,
      fallback,
      allowFetchFallback: true,
    })
    const r = await client.request({
      label: "t",
      method: "GET",
      url: "https://api.example.com/x",
    })
    expect(primaryCalled).toBe(1)
    expect(fallbackCalled).toBe(1)
    expect(r.transport.fallbackUsed).toBe(true)
  })
})

// ── Environment wiring sanity (MINIMAL_AGENT_HTTP3=opt|force|off) ────────

describe("createDefaultNetworkClient — MINIMAL_AGENT_HTTP3", () => {
  // We can't probe the client's policy array without exposing it, so
  // these tests just confirm the function doesn't throw for the
  // supported values. Bun's import-time singleton means real
  // integration coverage rides on the unit tests above.
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.MINIMAL_AGENT_HTTP3
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MINIMAL_AGENT_HTTP3
    else process.env.MINIMAL_AGENT_HTTP3 = originalEnv
  })

  // The import below is required so the dynamic import path works
  // with Bun's module resolver in the test env.
  test("accepts MINIMAL_AGENT_HTTP3=off without error", async () => {
    process.env.MINIMAL_AGENT_HTTP3 = "off"
    const { createDefaultNetworkClient } = await import("../client.ts")
    const client = createDefaultNetworkClient()
    expect(client).toBeDefined()
  })

  test("accepts MINIMAL_AGENT_HTTP3=opt without error", async () => {
    process.env.MINIMAL_AGENT_HTTP3 = "opt"
    const { createDefaultNetworkClient } = await import("../client.ts")
    const client = createDefaultNetworkClient()
    expect(client).toBeDefined()
  })

  test("accepts MINIMAL_AGENT_HTTP3=force without error", async () => {
    process.env.MINIMAL_AGENT_HTTP3 = "force"
    const { createDefaultNetworkClient } = await import("../client.ts")
    const client = createDefaultNetworkClient()
    expect(client).toBeDefined()
  })

  test("unrecognized value falls back to 'off' (with stderr warning)", async () => {
    process.env.MINIMAL_AGENT_HTTP3 = "garbage"
    const stderr = process.stderr
    const original = stderr.write.bind(stderr)
    const writes: string[] = []
    stderr.write = ((s: string | Uint8Array) => {
      writes.push(s.toString())
      return true
    }) as typeof stderr.write
    try {
      const { createDefaultNetworkClient } = await import("../client.ts")
      const client = createDefaultNetworkClient()
      expect(client).toBeDefined()
    } finally {
      stderr.write = original
    }
    expect(writes.some((s) => s.includes("MINIMAL_AGENT_HTTP3"))).toBe(true)
  })
})

import { describe, expect, test } from "bun:test"
import { Http3NegotiationCache, parseAltSvc } from "./http3-cache.ts"

describe("parseAltSvc", () => {
  test("returns h3=false for empty / whitespace", () => {
    expect(parseAltSvc("")).toEqual({ h3: false })
    expect(parseAltSvc("   ")).toEqual({ h3: false })
  })

  test("returns h3=false for non-h3 alternatives", () => {
    expect(parseAltSvc('h2=":443"; ma=86400')).toEqual({ h3: false })
    expect(parseAltSvc('h2c=":80"')).toEqual({ h3: false })
  })

  test("detects standard h3 advertisement", () => {
    const r = parseAltSvc('h3=":443"; ma=86400')
    expect(r.h3).toBe(true)
    expect(r.maxAgeSec).toBe(86400)
  })

  test("detects draft h3-29 advertisement", () => {
    const r = parseAltSvc('h3-29=":443"; ma=600')
    expect(r.h3).toBe(true)
    expect(r.maxAgeSec).toBe(600)
  })

  test("takes minimum ma across multiple h3 entries", () => {
    const r = parseAltSvc('h3=":443"; ma=86400, h3-29=":443"; ma=600, h2=":443"; ma=3600')
    expect(r.h3).toBe(true)
    expect(r.maxAgeSec).toBe(600)
  })

  test("ignores commas inside quoted strings", () => {
    const r = parseAltSvc('h3=":443,8443"; ma=3600')
    expect(r.h3).toBe(true)
    expect(r.maxAgeSec).toBe(3600)
  })

  test("ignores semicolons inside quoted strings", () => {
    const r = parseAltSvc('h3=":443"; ma=3600')
    expect(r.h3).toBe(true)
    expect(r.maxAgeSec).toBe(3600)
  })

  test("handles missing ma (no maxAgeSec field)", () => {
    const r = parseAltSvc('h3=":443"')
    expect(r.h3).toBe(true)
    expect(r.maxAgeSec).toBeUndefined()
  })

  test("rejects ma=0 and non-numeric ma", () => {
    expect(parseAltSvc('h3=":443"; ma=0').maxAgeSec).toBeUndefined()
    expect(parseAltSvc('h3=":443"; ma=foo').maxAgeSec).toBeUndefined()
  })

  test("is case-insensitive for protocol and param keys", () => {
    const r = parseAltSvc('H3=":443"; MA=300')
    expect(r.h3).toBe(true)
    expect(r.maxAgeSec).toBe(300)
  })
})

describe("Http3NegotiationCache", () => {
  test("unknown origin returns 'unknown'", () => {
    const cache = new Http3NegotiationCache()
    expect(cache.lookup("https://api.example.com")).toBe("unknown")
  })

  test("invalid origin string returns 'unknown' without throwing", () => {
    const cache = new Http3NegotiationCache()
    expect(cache.lookup("not-a-url")).toBe("unknown")
    expect(() => cache.recordAltSvc("not-a-url", "h3=:443")).not.toThrow()
    expect(() => cache.recordFailure("not-a-url", "handshake")).not.toThrow()
  })

  test("recordAltSvc with h3 entry promotes origin to 'supported'", () => {
    const cache = new Http3NegotiationCache()
    cache.recordAltSvc("https://api.example.com", 'h3=":443"; ma=86400')
    expect(cache.lookup("https://api.example.com")).toBe("supported")
  })

  test("recordAltSvc ignores non-h3 entries", () => {
    const cache = new Http3NegotiationCache()
    cache.recordAltSvc("https://api.example.com", 'h2=":443"')
    expect(cache.lookup("https://api.example.com")).toBe("unknown")
  })

  test("recordAltSvc with null / empty header is a no-op", () => {
    const cache = new Http3NegotiationCache()
    cache.recordAltSvc("https://api.example.com", null)
    cache.recordAltSvc("https://api.example.com", "")
    cache.recordAltSvc("https://api.example.com", undefined)
    expect(cache.lookup("https://api.example.com")).toBe("unknown")
  })

  test("recordFailure('handshake') marks origin 'unsupported'", () => {
    const cache = new Http3NegotiationCache()
    cache.recordFailure("https://api.example.com", "handshake")
    expect(cache.lookup("https://api.example.com")).toBe("unsupported")
  })

  test("recordFailure('network') does not touch the cache", () => {
    const cache = new Http3NegotiationCache()
    cache.recordAltSvc("https://api.example.com", 'h3=":443"; ma=86400')
    cache.recordFailure("https://api.example.com", "network")
    expect(cache.lookup("https://api.example.com")).toBe("supported")
  })

  test("recordFailure('abort') does not touch the cache", () => {
    const cache = new Http3NegotiationCache()
    cache.recordAltSvc("https://api.example.com", 'h3=":443"; ma=86400')
    cache.recordFailure("https://api.example.com", "abort")
    expect(cache.lookup("https://api.example.com")).toBe("supported")
  })

  test("recordFailure on a previously-supported origin downgrades it", () => {
    const cache = new Http3NegotiationCache()
    cache.recordAltSvc("https://api.example.com", 'h3=":443"; ma=86400')
    expect(cache.lookup("https://api.example.com")).toBe("supported")
    cache.recordFailure("https://api.example.com", "handshake")
    expect(cache.lookup("https://api.example.com")).toBe("unsupported")
  })

  test("origin normalization collapses path/query/fragment", () => {
    const cache = new Http3NegotiationCache()
    cache.recordAltSvc("https://api.example.com/v1/x?foo=1#frag", 'h3=":443"')
    expect(cache.lookup("https://api.example.com")).toBe("supported")
    expect(cache.lookup("https://api.example.com/something/else")).toBe("supported")
  })

  test("different ports / schemes are treated as different origins", () => {
    const cache = new Http3NegotiationCache()
    cache.recordAltSvc("https://api.example.com:8443/", 'h3=":443"')
    expect(cache.lookup("https://api.example.com:8443")).toBe("supported")
    expect(cache.lookup("https://api.example.com")).toBe("unknown")
    expect(cache.lookup("https://api.example.com:443")).toBe("unknown")
    expect(cache.lookup("http://api.example.com:8443")).toBe("unknown")
  })

  test("positive TTL expires entries", () => {
    let now = 1_000_000
    const cache = new Http3NegotiationCache({ now: () => now })
    cache.recordAltSvc("https://api.example.com", 'h3=":443"; ma=10') // 10s
    expect(cache.lookup("https://api.example.com")).toBe("supported")
    now += 9_000
    expect(cache.lookup("https://api.example.com")).toBe("supported")
    now += 2_000
    expect(cache.lookup("https://api.example.com")).toBe("unknown")
  })

  test("server ma= is capped at positiveTtlMs option", () => {
    let now = 1_000_000
    const cache = new Http3NegotiationCache({
      now: () => now,
      positiveTtlMs: 5_000, // 5 seconds
    })
    cache.recordAltSvc("https://api.example.com", 'h3=":443"; ma=86400') // server says 24h
    now += 6_000
    // cap kicked in → expired
    expect(cache.lookup("https://api.example.com")).toBe("unknown")
  })

  test("negative TTL is shorter and self-heals", () => {
    let now = 1_000_000
    const cache = new Http3NegotiationCache({
      now: () => now,
      negativeTtlMs: 1_000,
    })
    cache.recordFailure("https://api.example.com", "handshake")
    expect(cache.lookup("https://api.example.com")).toBe("unsupported")
    now += 2_000
    expect(cache.lookup("https://api.example.com")).toBe("unknown")
  })

  test("re-recording an alt-svc refreshes the TTL", () => {
    let now = 1_000_000
    const cache = new Http3NegotiationCache({ now: () => now })
    cache.recordAltSvc("https://api.example.com", 'h3=":443"; ma=100')
    now += 80_000
    expect(cache.lookup("https://api.example.com")).toBe("supported")
    cache.recordAltSvc("https://api.example.com", 'h3=":443"; ma=100')
    now += 80_000
    // 160s elapsed total but the refresh extended us
    expect(cache.lookup("https://api.example.com")).toBe("supported")
  })

  test("seed() installs a verdict with default TTL", () => {
    const cache = new Http3NegotiationCache()
    cache.seed("https://api.example.com", "supported")
    expect(cache.lookup("https://api.example.com")).toBe("supported")
    cache.seed("https://api.example.com", "unsupported")
    expect(cache.lookup("https://api.example.com")).toBe("unsupported")
  })

  test("seed('unknown') removes any existing entry", () => {
    const cache = new Http3NegotiationCache()
    cache.seed("https://api.example.com", "supported")
    cache.seed("https://api.example.com", "unknown")
    expect(cache.lookup("https://api.example.com")).toBe("unknown")
  })

  test("seed with custom ttlMs is honored", () => {
    let now = 1_000_000
    const cache = new Http3NegotiationCache({ now: () => now })
    cache.seed("https://api.example.com", "supported", 500)
    expect(cache.lookup("https://api.example.com")).toBe("supported")
    now += 600
    expect(cache.lookup("https://api.example.com")).toBe("unknown")
  })

  test("clear() empties the cache and returns count", () => {
    const cache = new Http3NegotiationCache()
    cache.seed("https://a.example.com", "supported")
    cache.seed("https://b.example.com", "supported")
    expect(cache.clear()).toBe(2)
    expect(cache.lookup("https://a.example.com")).toBe("unknown")
    expect(cache.size()).toBe(0)
  })

  test("size() excludes expired entries", () => {
    let now = 1_000_000
    const cache = new Http3NegotiationCache({ now: () => now })
    cache.seed("https://a.example.com", "supported", 1_000)
    cache.seed("https://b.example.com", "supported", 10_000)
    expect(cache.size()).toBe(2)
    now += 2_000
    expect(cache.size()).toBe(1)
  })
})

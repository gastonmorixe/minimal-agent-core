import { describe, expect, it } from "bun:test"

import {
  type CacheTtl,
  DEFAULT_CACHE_TTL,
  KNOWN_CACHE_TTLS,
  normalizeCacheTtl,
  resolveCacheTtl,
} from "./cache-ttl.ts"

describe("cache-ttl constants", () => {
  it("defaults to 5m", () => {
    expect(DEFAULT_CACHE_TTL).toBe("5m")
  })

  it("knows exactly the two accepted TTL buckets", () => {
    expect(KNOWN_CACHE_TTLS).toEqual(["5m", "1h"])
  })
})

describe("normalizeCacheTtl", () => {
  it("passes through the two valid buckets", () => {
    expect(normalizeCacheTtl("5m")).toBe("5m")
    expect(normalizeCacheTtl("1h")).toBe("1h")
  })

  it("rejects everything else (undefined, empty, junk, wrong unit)", () => {
    for (const bad of [undefined, "", "2h", "5s", "1H", "5M", "300s", "foo"]) {
      expect(normalizeCacheTtl(bad)).toBeUndefined()
    }
  })
})

describe("resolveCacheTtl", () => {
  it("falls back to the default (5m) when nothing is set", () => {
    expect(resolveCacheTtl({})).toEqual({ ttl: "5m", source: "default" })
  })

  it("CLI wins over env and config", () => {
    expect(resolveCacheTtl({ cli: "1h", env: "5m", config: "5m" })).toEqual({
      ttl: "1h",
      source: "cli",
    })
  })

  it("env wins over config when no CLI value", () => {
    expect(resolveCacheTtl({ env: "1h", config: "5m" })).toEqual({ ttl: "1h", source: "env" })
  })

  it("config wins when it is the only source", () => {
    expect(resolveCacheTtl({ config: "1h" })).toEqual({ ttl: "1h", source: "config" })
  })

  it("skips an invalid higher-precedence layer and uses the next valid one", () => {
    // Invalid CLI ("2h") + invalid env ("") → config wins.
    expect(resolveCacheTtl({ cli: "2h", env: "", config: "1h" })).toEqual({
      ttl: "1h",
      source: "config",
    })
  })

  it("treats an empty-string CLI value as unset (env takes over)", () => {
    expect(resolveCacheTtl({ cli: "", env: "1h" })).toEqual({ ttl: "1h", source: "env" })
  })

  it("all-invalid sources resolve to the default", () => {
    expect(resolveCacheTtl({ cli: "10m", env: "nope", config: "" })).toEqual({
      ttl: "5m",
      source: "default",
    })
  })

  it("always returns a concrete CacheTtl", () => {
    const resolved: CacheTtl = resolveCacheTtl({}).ttl
    expect(KNOWN_CACHE_TTLS).toContain(resolved)
  })
})

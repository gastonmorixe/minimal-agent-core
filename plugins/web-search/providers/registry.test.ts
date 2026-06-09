/**
 * Tests for the chain runner — the contract that defines how the plugin
 * recovers from a misconfigured / broken provider.
 *
 * Key invariants verified:
 *   - Skip on `!isConfigured`
 *   - Advance on thrown error (any kind)
 *   - DO NOT advance on empty results
 *   - All exhausted → `WebSearchAllFailedError` carrying every failure
 *   - Unknown ids in `buildChain` are dropped, not thrown
 */

import { describe, expect, test } from "bun:test"

import { defaultConfig, type WebSearchConfig } from "../config.ts"

import { buildChain, runChain, WebSearchAllFailedError } from "./registry.ts"
import type { ProviderFactory, SearchHit, SearchOptions, WebSearchProvider } from "./types.ts"
import { WebSearchProviderError } from "./types.ts"

const opts: SearchOptions = { type: "web", count: 5 }

function stub(
  id: string,
  behavior: {
    configured?: boolean
    hits?: SearchHit[]
    throws?: Error
  } = {},
): WebSearchProvider {
  return {
    id,
    displayName: id,
    capabilities: new Set(["web", "news"]),
    isConfigured: () => behavior.configured ?? true,
    search: async () => {
      if (behavior.throws) throw behavior.throws
      return {
        query: "q",
        provider: id,
        type: "web",
        hits: behavior.hits ?? [],
      }
    },
  }
}

describe("buildChain", () => {
  test("constructs known providers in order, drops unknown", () => {
    const fakeFactory: ProviderFactory = () => stub("fake")
    const factories = { brave: fakeFactory, other: fakeFactory }
    const messages: string[] = []
    const cfg: WebSearchConfig = {
      ...defaultConfig(),
      providers: ["brave", "missing", "other"],
    }
    const chain = buildChain(cfg, factories, (m) => messages.push(m))
    expect(chain.map((p) => p.id)).toEqual(["fake", "fake"])
    expect(messages).toEqual(['unknown provider "missing" — skipping'])
  })

  test("empty providers → empty chain", () => {
    const cfg: WebSearchConfig = { ...defaultConfig(), providers: [] }
    expect(buildChain(cfg, {}, () => {})).toEqual([])
  })
})

describe("runChain", () => {
  test("returns first successful response", async () => {
    const a = stub("a", { hits: [{ title: "T", url: "u", type: "web" }] })
    const b = stub("b", { hits: [{ title: "B", url: "u2", type: "web" }] })
    const resp = await runChain("q", opts, [a, b], new AbortController().signal)
    expect(resp.provider).toBe("a")
    expect(resp.hits).toHaveLength(1)
  })

  test("skips not-configured providers", async () => {
    const a = stub("a", { configured: false })
    const b = stub("b", { hits: [{ title: "B", url: "u", type: "web" }] })
    const resp = await runChain("q", opts, [a, b], new AbortController().signal)
    expect(resp.provider).toBe("b")
  })

  test("advances on thrown error", async () => {
    const a = stub("a", { throws: new WebSearchProviderError("a", "boom") })
    const b = stub("b", { hits: [{ title: "B", url: "u", type: "web" }] })
    const messages: string[] = []
    const resp = await runChain("q", opts, [a, b], new AbortController().signal, process.env, (m) =>
      messages.push(m),
    )
    expect(resp.provider).toBe("b")
    expect(messages[0]).toMatch(/provider "a" failed: boom/)
  })

  test("does NOT advance on empty results", async () => {
    const a = stub("a", { hits: [] })
    const b = stub("b", { hits: [{ title: "B", url: "u", type: "web" }] })
    const resp = await runChain("q", opts, [a, b], new AbortController().signal)
    expect(resp.provider).toBe("a") // empty is a valid stop
    expect(resp.hits).toEqual([])
  })

  test("all-failed throws WebSearchAllFailedError with full trail", async () => {
    const a = stub("a", { configured: false })
    const b = stub("b", { throws: new Error("network") })
    let caught: unknown
    try {
      await runChain("q", opts, [a, b], new AbortController().signal)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WebSearchAllFailedError)
    const failures = (caught as WebSearchAllFailedError).failures
    expect(failures).toHaveLength(2)
    expect(failures[0]).toEqual({
      providerId: "a",
      kind: "not_configured",
      message: "not configured (missing API key)",
    })
    expect(failures[1].providerId).toBe("b")
    expect(failures[1].kind).toBe("error")
    expect(failures[1].message).toBe("network")
  })

  test("empty chain throws all-failed with no-providers reason", async () => {
    let caught: unknown
    try {
      await runChain("q", opts, [], new AbortController().signal)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WebSearchAllFailedError)
    expect((caught as WebSearchAllFailedError).failures).toEqual([])
    expect((caught as Error).message).toContain("no providers configured")
  })
})

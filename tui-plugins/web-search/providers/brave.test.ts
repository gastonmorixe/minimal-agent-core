/**
 * Tests for the Brave provider.
 *
 * No live HTTP — `fetch` is injected via the provider's config block.
 * Fixtures are real-shape Brave responses (trimmed) so the normalizer is
 * exercised against actual server output, not a hand-written ideal.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { braveFactory, buildQueryParams, MAX_QUERY_LENGTH } from "./brave.ts"
import { WebSearchProviderError, type SearchOptions } from "./types.ts"

const FIX_DIR = join(import.meta.dirname ?? __dirname, "__fixtures__")
const fix = (name: string): unknown => JSON.parse(readFileSync(join(FIX_DIR, name), "utf-8"))

const baseOpts: SearchOptions = {
  type: "web",
  count: 10,
  country: "US",
  lang: "en",
  safesearch: "moderate",
}

function makeFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    return Promise.resolve(impl(String(url), init ?? {}))
  }) as typeof fetch
}

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: { "content-type": "application/json" },
  })
}

describe("buildQueryParams", () => {
  test("happy path encodes core params", () => {
    const p = buildQueryParams("rust async", { ...baseOpts, count: 5 })
    expect(p.get("q")).toBe("rust async")
    expect(p.get("count")).toBe("5")
    expect(p.get("country")).toBe("US")
    expect(p.get("search_lang")).toBe("en")
    expect(p.get("safesearch")).toBe("moderate")
    expect(p.get("text_decorations")).toBe("false")
    expect(p.get("spellcheck")).toBe("true")
  })

  test("clamps count to vertical cap", () => {
    expect(buildQueryParams("q", { ...baseOpts, type: "web", count: 999 }).get("count")).toBe("20")
    expect(buildQueryParams("q", { ...baseOpts, type: "news", count: 999 }).get("count")).toBe("50")
    expect(buildQueryParams("q", { ...baseOpts, count: 0 }).get("count")).toBe("1")
  })

  test("offset omitted when 0; clamped to 9", () => {
    expect(buildQueryParams("q", { ...baseOpts }).has("offset")).toBe(false)
    expect(buildQueryParams("q", { ...baseOpts, offset: 5 }).get("offset")).toBe("5")
    expect(buildQueryParams("q", { ...baseOpts, offset: 99 }).get("offset")).toBe("9")
  })

  test("freshness passes through", () => {
    expect(buildQueryParams("q", { ...baseOpts, freshness: "pw" }).get("freshness")).toBe("pw")
  })
})

describe("BraveProvider.isConfigured", () => {
  test("true when env has the key", () => {
    const p = braveFactory({})
    expect(p.isConfigured({ BRAVE_API_KEY: "k" })).toBe(true)
  })
  test("false when no key", () => {
    const p = braveFactory({})
    expect(p.isConfigured({})).toBe(false)
  })
  test("inline apiKey wins", () => {
    const p = braveFactory({ apiKey: "inline" })
    expect(p.isConfigured({})).toBe(true)
  })
  test("custom apiKeyEnv is respected", () => {
    const p = braveFactory({ apiKeyEnv: "MY_KEY" })
    expect(p.isConfigured({ MY_KEY: "v" })).toBe(true)
    expect(p.isConfigured({ BRAVE_API_KEY: "v" })).toBe(false)
  })
})

describe("BraveProvider.search (web)", () => {
  test("normalizes a real-shape web response", async () => {
    let capturedUrl = ""
    let capturedHeaders: Headers | undefined
    const provider = braveFactory({
      apiKey: "test-key",
      fetch: makeFetch((url, init) => {
        capturedUrl = url
        capturedHeaders = new Headers(init.headers as HeadersInit)
        return jsonResponse(fix("brave-web.json"))
      }),
    })
    const resp = await provider.search("rust async runtime", baseOpts, new AbortController().signal)

    // URL & headers wired correctly
    expect(capturedUrl).toContain("/web/search?")
    expect(capturedUrl).toContain("q=rust+async+runtime")
    expect(capturedHeaders?.get("X-Subscription-Token")).toBe("test-key")

    // Two valid hits (third is dropped — missing URL)
    expect(resp.provider).toBe("brave")
    expect(resp.type).toBe("web")
    expect(resp.hits).toHaveLength(2)

    const [first, second] = resp.hits
    expect(first.title).toBe("Tokio - An asynchronous Rust runtime")
    expect(first.url).toBe("https://tokio.rs/")
    // <strong> markers stripped from description even when text_decorations=false (defense-in-depth)
    expect(first.snippet).toBe("Tokio is an asynchronous runtime for the Rust programming language.")
    expect(first.age).toBe("3 days ago")
    expect(first.source).toBe("tokio.rs")
    expect(first.thumbnail).toBe("https://example.com/tokio.png")
    expect(first.type).toBe("web")

    // Second result falls back to page_age when age is missing
    expect(second.age).toBe("2024-11-01T00:00:00")
    expect(second.source).toBe("github.com")
  })
})

describe("BraveProvider.search (news)", () => {
  test("normalizes a real-shape news response", async () => {
    const provider = braveFactory({
      apiKey: "test-key",
      fetch: makeFetch((url) => {
        expect(url).toContain("/news/search?")
        return jsonResponse(fix("brave-news.json"))
      }),
    })
    const resp = await provider.search(
      "ai regulation",
      { ...baseOpts, type: "news" },
      new AbortController().signal,
    )
    expect(resp.type).toBe("news")
    expect(resp.hits).toHaveLength(2)
    expect(resp.hits[0].type).toBe("news")
    expect(resp.hits[0].source).toBe("example-news.com")
    expect(resp.hits[0].url).toBe("https://example-news.com/eu-ai")
  })
})

describe("BraveProvider.search errors", () => {
  test("missing key throws", async () => {
    const p = braveFactory({}) // no apiKey configured, no env mocking
    const prevKey = process.env.BRAVE_API_KEY
    delete process.env.BRAVE_API_KEY
    try {
      await expect(p.search("q", baseOpts, new AbortController().signal)).rejects.toThrow(
        WebSearchProviderError,
      )
    } finally {
      if (prevKey !== undefined) process.env.BRAVE_API_KEY = prevKey
    }
  })

  test("non-2xx throws WebSearchProviderError with body excerpt", async () => {
    const p = braveFactory({
      apiKey: "k",
      fetch: makeFetch(() => new Response("forbidden", { status: 403, statusText: "Forbidden" })),
    })
    await expect(p.search("q", baseOpts, new AbortController().signal)).rejects.toThrow(/HTTP 403/)
  })

  test("invalid JSON throws", async () => {
    const p = braveFactory({
      apiKey: "k",
      fetch: makeFetch(() => new Response("not json", { status: 200 })),
    })
    await expect(p.search("q", baseOpts, new AbortController().signal)).rejects.toThrow(/invalid JSON/)
  })

  test("network failure throws fetch failed", async () => {
    const p = braveFactory({
      apiKey: "k",
      fetch: makeFetch(() => {
        throw new Error("ECONNREFUSED")
      }),
    })
    await expect(p.search("q", baseOpts, new AbortController().signal)).rejects.toThrow(/fetch failed/)
  })

  test("oversized query rejected client-side", async () => {
    const p = braveFactory({ apiKey: "k", fetch: makeFetch(() => jsonResponse({})) })
    const long = "x".repeat(MAX_QUERY_LENGTH + 1)
    await expect(p.search(long, baseOpts, new AbortController().signal)).rejects.toThrow(/exceeds 400/)
  })

  test("aborts via signal", async () => {
    const p = braveFactory({
      apiKey: "k",
      fetch: makeFetch(async (_url, init) => {
        // Simulate fetch honoring the signal
        if (init.signal?.aborted) throw new Error("AbortError")
        return jsonResponse({})
      }),
    })
    const ac = new AbortController()
    ac.abort()
    await expect(p.search("q", baseOpts, ac.signal)).rejects.toThrow(/fetch failed/)
  })
})

describe("BraveProvider.search empty results", () => {
  test("empty results are returned, NOT thrown", async () => {
    const p = braveFactory({
      apiKey: "k",
      fetch: makeFetch(() => jsonResponse({ web: { results: [] }, query: { original: "q" } })),
    })
    const resp = await p.search("q", baseOpts, new AbortController().signal)
    expect(resp.hits).toEqual([])
    expect(resp.provider).toBe("brave")
  })
})

/**
 * Tests for the Brave provider.
 *
 * No live HTTP — `fetch` is injected via the provider's config block.
 * Fixtures are real-shape Brave responses (trimmed) so the normalizer is
 * exercised against actual server output, not a hand-written ideal.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { braveFactory, buildQueryParams, MAX_QUERY_LENGTH } from "./brave.ts"
import { type SearchOptions, WebSearchProviderError } from "./types.ts"

const FIX_DIR = join(import.meta.dirname ?? __dirname, "__fixtures__")
const fix = (name: string): unknown => JSON.parse(readFileSync(join(FIX_DIR, name), "utf-8"))

const baseOpts: SearchOptions = {
  type: "web",
  count: 10,
  country: "US",
  lang: "en",
  safesearch: "moderate",
}

function makeFetch(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    return Promise.resolve(impl(String(url), init ?? {}))
  }) as typeof fetch
}

function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
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
    expect(first.snippet).toBe(
      "Tokio is an asynchronous runtime for the Rust programming language.",
    )
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
    await expect(p.search("q", baseOpts, new AbortController().signal)).rejects.toThrow(
      /invalid JSON/,
    )
  })

  test("network failure throws fetch failed", async () => {
    const p = braveFactory({
      apiKey: "k",
      fetch: makeFetch(() => {
        throw new Error("ECONNREFUSED")
      }),
      // Disable retry — without this, the default 3-attempt policy makes
      // this test take ~1s due to backoff sleeps.
      retry: { maxAttempts: 1 },
    })
    await expect(p.search("q", baseOpts, new AbortController().signal)).rejects.toThrow(
      /fetch failed/,
    )
  })

  test("oversized query rejected client-side", async () => {
    const p = braveFactory({ apiKey: "k", fetch: makeFetch(() => jsonResponse({})) })
    const long = "x".repeat(MAX_QUERY_LENGTH + 1)
    await expect(p.search(long, baseOpts, new AbortController().signal)).rejects.toThrow(
      /exceeds 400/,
    )
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

// --- retry behavior ------------------------------------------------------
//
// Verifies the wiring between brave.ts and src/retry.ts: which statuses
// trigger backoff, Retry-After honoring, exhaustion → existing
// `!resp.ok` body-excerpt path, and the test-only `retry.maxAttempts: 1`
// escape hatch.

describe("BraveProvider.search — retry behavior", () => {
  test("recovers from a transient 429 then succeeds on retry", async () => {
    let attempts = 0
    const p = braveFactory({
      apiKey: "k",
      // Tiny delays so the test runs fast even though retry IS exercised.
      retry: { baseDelayMs: 1, maxDelayMs: 1 },
      fetch: makeFetch(() => {
        attempts++
        if (attempts === 1) {
          return new Response("rate limited", { status: 429, statusText: "Too Many Requests" })
        }
        return jsonResponse({ web: { results: [] }, query: { original: "q" } })
      }),
    })
    const resp = await p.search("q", baseOpts, new AbortController().signal)
    expect(attempts).toBe(2)
    expect(resp.provider).toBe("brave")
  })

  test("honors Retry-After header (seconds form) as a floor", async () => {
    let attempts = 0
    const onRetryDelays: number[] = []
    const p = braveFactory({
      apiKey: "k",
      retry: {
        baseDelayMs: 1, // tiny jitter — Retry-After should dominate
        maxDelayMs: 100,
        // Capture observed delay for assertion.
        onRetry: ({ delayMs }: { delayMs: number }) => onRetryDelays.push(delayMs),
      },
      fetch: makeFetch(() => {
        attempts++
        if (attempts === 1) {
          return new Response("", {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "retry-after": "1" },
          })
        }
        return jsonResponse({ web: { results: [] } })
      }),
    })
    await p.search("q", baseOpts, new AbortController().signal)
    expect(attempts).toBe(2)
    // 1 second from Retry-After, capped at maxDelayMs=100ms → 100.
    expect(onRetryDelays).toEqual([100])
  })

  test("HTTP-date Retry-After form falls back to jitter (not parsed)", async () => {
    let attempts = 0
    const onRetryDelays: number[] = []
    const p = braveFactory({
      apiKey: "k",
      retry: {
        baseDelayMs: 5,
        maxDelayMs: 50,
        onRetry: ({ delayMs }: { delayMs: number }) => onRetryDelays.push(delayMs),
      },
      fetch: makeFetch(() => {
        attempts++
        if (attempts === 1) {
          return new Response("", {
            status: 503,
            headers: { "retry-after": "Wed, 21 Oct 2099 07:28:00 GMT" },
          })
        }
        return jsonResponse({ web: { results: [] } })
      }),
    })
    await p.search("q", baseOpts, new AbortController().signal)
    expect(attempts).toBe(2)
    // Pure jitter: somewhere in [0, baseDelayMs=5).
    expect(onRetryDelays[0]).toBeGreaterThanOrEqual(0)
    expect(onRetryDelays[0]).toBeLessThan(5)
  })

  test("retries 502/503/504 (transient upstream errors)", async () => {
    for (const status of [502, 503, 504]) {
      let attempts = 0
      const p = braveFactory({
        apiKey: "k",
        retry: { baseDelayMs: 1, maxDelayMs: 1 },
        fetch: makeFetch(() => {
          attempts++
          if (attempts === 1) return new Response("", { status })
          return jsonResponse({ web: { results: [] } })
        }),
      })
      await p.search("q", baseOpts, new AbortController().signal)
      expect(attempts).toBe(2)
    }
  })

  test("does NOT retry 4xx (other than 429) or 500", async () => {
    for (const status of [400, 401, 403, 404, 500]) {
      let attempts = 0
      const p = braveFactory({
        apiKey: "k",
        retry: { baseDelayMs: 1, maxDelayMs: 1 },
        fetch: makeFetch(() => {
          attempts++
          return new Response("bad", { status })
        }),
      })
      await expect(p.search("q", baseOpts, new AbortController().signal)).rejects.toThrow(
        new RegExp(`HTTP ${status}`),
      )
      expect(attempts).toBe(1) // exactly one call — no retry
    }
  })

  test("exhausts retries on persistent 429 and surfaces body excerpt", async () => {
    let attempts = 0
    const p = braveFactory({
      apiKey: "k",
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      fetch: makeFetch(() => {
        attempts++
        return new Response("plan exhausted", { status: 429, statusText: "Too Many Requests" })
      }),
    })
    await expect(p.search("q", baseOpts, new AbortController().signal)).rejects.toThrow(
      /HTTP 429.*plan exhausted/,
    )
    expect(attempts).toBe(3) // full exhaustion
  })

  test("network errors retry up to maxAttempts then bubble as fetch failed", async () => {
    let attempts = 0
    const p = braveFactory({
      apiKey: "k",
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      fetch: makeFetch(() => {
        attempts++
        throw new Error("ECONNRESET")
      }),
    })
    await expect(p.search("q", baseOpts, new AbortController().signal)).rejects.toThrow(
      /fetch failed: ECONNRESET/,
    )
    expect(attempts).toBe(3)
  })

  test("retry.maxAttempts:1 disables retry (one call only)", async () => {
    let attempts = 0
    const p = braveFactory({
      apiKey: "k",
      retry: { maxAttempts: 1 },
      fetch: makeFetch(() => {
        attempts++
        return new Response("", { status: 429 })
      }),
    })
    await expect(p.search("q", baseOpts, new AbortController().signal)).rejects.toThrow(/HTTP 429/)
    expect(attempts).toBe(1)
  })

  test("AbortSignal aborts retry loop without consuming the full budget", async () => {
    let attempts = 0
    const ac = new AbortController()
    const p = braveFactory({
      apiKey: "k",
      retry: { maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 50 },
      fetch: makeFetch(() => {
        attempts++
        // Schedule an abort right after the first failure so the
        // subsequent backoff sleep is interrupted.
        if (attempts === 1) queueMicrotask(() => ac.abort(new Error("user-cancel")))
        return new Response("", { status: 503 })
      }),
    })
    await expect(p.search("q", baseOpts, ac.signal)).rejects.toThrow(/fetch failed: user-cancel/)
    expect(attempts).toBe(1)
  })
})

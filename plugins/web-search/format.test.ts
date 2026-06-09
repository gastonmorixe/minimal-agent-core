import { describe, expect, test } from "bun:test"

import { formatJson, formatText } from "./format.ts"
import type { SearchResponse } from "./providers/types.ts"

const resp: SearchResponse = {
  query: "rust async",
  provider: "brave",
  type: "web",
  hits: [
    {
      title: "Tokio — runtime",
      url: "https://tokio.rs/",
      snippet: "Asynchronous runtime for Rust.",
      age: "3 days ago",
      source: "tokio.rs",
      type: "web",
    },
    {
      title: "Other",
      url: "https://example.org/x",
      snippet: "x",
      type: "web",
    },
  ],
}

describe("formatText", () => {
  test("plain (no ansi) shape", () => {
    const t = formatText(resp)
    expect(t).toContain('WebSearch[brave/web] "rust async" — 2 results')
    expect(t).toContain("[1] Tokio — runtime — tokio.rs · 3 days ago")
    expect(t).toContain("    https://tokio.rs/")
    expect(t).toContain("    Asynchronous runtime for Rust.")
    expect(t).toContain("[2] Other — example.org") // hostname fallback for source
    // No ANSI escapes in plain mode
    expect(t).not.toContain("\x1b[")
  })

  test("ansi mode adds escape codes", () => {
    const t = formatText(resp, { ansi: true })
    expect(t).toContain("\x1b[1m") // bold for title
    expect(t).toContain("\x1b[2m") // dim for url
  })

  test("singular vs plural results word", () => {
    const one: SearchResponse = { ...resp, hits: [resp.hits[0]] }
    expect(formatText(one)).toContain("— 1 result\n")
    expect(formatText(resp)).toContain("— 2 results\n")
  })

  test("empty results renders (no results)", () => {
    const empty: SearchResponse = { ...resp, hits: [] }
    const t = formatText(empty)
    expect(t).toContain("(no results)")
  })

  test("flattens multi-line snippets", () => {
    const r: SearchResponse = {
      ...resp,
      hits: [{ ...resp.hits[0], snippet: "line1\n\n  line2\t  line3" }],
    }
    expect(formatText(r)).toContain("    line1 line2 line3")
  })

  test("trims long snippets to ~240 chars with ellipsis", () => {
    const long = "x".repeat(500)
    const r: SearchResponse = { ...resp, hits: [{ ...resp.hits[0], snippet: long }] }
    const t = formatText(r)
    const snippetLine = t.split("\n").find((l) => l.includes("xxxx"))!
    expect(snippetLine.length).toBeLessThanOrEqual(244 + 4) // 240 max + indent
    expect(snippetLine).toMatch(/…$/)
  })
})

describe("formatJson", () => {
  test("emits compact structured shape", () => {
    const j = formatJson(resp)
    expect(j.query).toBe("rust async")
    expect(j.provider).toBe("brave")
    expect(j.type).toBe("web")
    expect(j.hits).toHaveLength(2)
    expect(j.hits[0]).toEqual({
      title: "Tokio — runtime",
      url: "https://tokio.rs/",
      snippet: "Asynchronous runtime for Rust.",
      age: "3 days ago",
      source: "tokio.rs",
    })
    // hostname fallback
    expect(j.hits[1].source).toBe("example.org")
  })

  test("omits absent optional fields", () => {
    const r: SearchResponse = {
      ...resp,
      hits: [{ title: "T", url: "https://t.io/", type: "web" }],
    }
    const j = formatJson(r)
    expect(j.hits[0]).toEqual({ title: "T", url: "https://t.io/", source: "t.io" })
  })
})

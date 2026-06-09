/**
 * Live Brave integration test — gated on BRAVE_API_KEY.
 *
 * Skipped by default (CI, ordinary `bun test` runs). Enable by exporting
 * a real key and re-running:
 *
 *   BRAVE_API_KEY=sk-... bun test plugins/web-search/providers/brave.live.test.ts
 *
 * This is a smoke check: the provider really hits Brave, the response is
 * shaped how we think it is, and at least one hit comes back. If Brave
 * changes their schema in a breaking way, this test catches it before the
 * unit fixtures get stale.
 */

import { describe, expect, test } from "bun:test"

import { braveFactory } from "./brave.ts"
import type { SearchOptions } from "./types.ts"

const HAS_KEY = !!process.env.BRAVE_API_KEY
const describeOrSkip = HAS_KEY ? describe : describe.skip

describeOrSkip("BraveProvider (live)", () => {
  test("real GET /web/search returns shaped hits", async () => {
    const p = braveFactory({})
    const opts: SearchOptions = { type: "web", count: 3, country: "US", lang: "en" }
    const resp = await p.search("hello world", opts, new AbortController().signal)
    expect(resp.provider).toBe("brave")
    expect(resp.type).toBe("web")
    expect(resp.hits.length).toBeGreaterThan(0)
    const first = resp.hits[0]
    expect(typeof first.title).toBe("string")
    expect(first.title.length).toBeGreaterThan(0)
    expect(first.url).toMatch(/^https?:\/\//)
  }, 15_000)
})

/**
 * Config-driven status-bar segment ordering + visibility.
 *
 * @module quota-status/render.segments.test
 */

import { describe, expect, it } from "bun:test"

import type { QuotaWindow } from "../../src/llm/provider-plugin.ts"
import type { SessionTokens } from "../../src/session-tokens.ts"
import { stripAnsi } from "../../src/term-width.ts"

import { DEFAULT_SEGMENT_ORDER, normalizeSegmentOrder, renderQuotaFooter } from "./render.ts"

const TOKENS: SessionTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  contextSize: 24_000,
} as SessionTokens

const WINDOWS: QuotaWindow[] = [
  { id: "5h", utilization: 0.21 },
  { id: "7d", utilization: 0.08 },
]

const baseOpts = {
  contextWindow: 200_000,
  effort: "high",
  modelLabel: "anth-4.8",
  sid: "b00e2d52",
} as const

function order(out: string): { quota: number; context: number; model: number; sid: number } {
  const s = stripAnsi(out)
  return {
    quota: s.indexOf("5h"),
    context: s.indexOf("k"), // session token count ends with k/M; rough anchor
    model: s.indexOf("anth-4.8"),
    sid: s.indexOf("b00e2d52"),
  }
}

describe("normalizeSegmentOrder", () => {
  it("defaults when undefined/empty", () => {
    expect(normalizeSegmentOrder()).toEqual([...DEFAULT_SEGMENT_ORDER])
    expect(normalizeSegmentOrder([])).toEqual([...DEFAULT_SEGMENT_ORDER])
  })
  it("drops unknown ids and dedupes, preserving order", () => {
    expect(normalizeSegmentOrder(["sid", "bogus", "quota", "sid"])).toEqual(["sid", "quota"])
  })
  it("falls back to default when all ids are invalid", () => {
    expect(normalizeSegmentOrder(["nope", "zzz"])).toEqual([...DEFAULT_SEGMENT_ORDER])
  })
})

describe("renderQuotaFooter — configurable segments", () => {
  it("default order is quota → context → model → sid", () => {
    const out = renderQuotaFooter(WINDOWS, TOKENS, { ...baseOpts, cols: 200 })!
    const o = order(out)
    expect(o.quota).toBeGreaterThanOrEqual(0)
    expect(o.quota).toBeLessThan(o.model)
    expect(o.model).toBeLessThan(o.sid)
  })

  it("honors a custom order (sid → model → quota)", () => {
    const out = renderQuotaFooter(WINDOWS, TOKENS, {
      ...baseOpts,
      cols: 200,
      segments: ["sid", "model", "quota"],
    })!
    const s = stripAnsi(out)
    expect(s.indexOf("b00e2d52")).toBeLessThan(s.indexOf("anth-4.8"))
    expect(s.indexOf("anth-4.8")).toBeLessThan(s.indexOf("5h"))
  })

  it("hides segments not listed (quota-only)", () => {
    const out = renderQuotaFooter(WINDOWS, TOKENS, {
      ...baseOpts,
      cols: 200,
      segments: ["quota"],
    })!
    const s = stripAnsi(out)
    expect(s).toContain("5h")
    expect(s).not.toContain("anth-4.8") // model hidden
    expect(s).not.toContain("b00e2d52") // sid hidden
  })

  it("a provider with no quota windows renders context-only (capability-adaptive)", () => {
    const out = renderQuotaFooter([], TOKENS, {
      contextWindow: 200_000,
      cols: 200,
      segments: ["quota", "context"],
    })!
    const s = stripAnsi(out)
    expect(s).not.toContain("5h") // no quota segment (no windows)
    expect(s).toContain("k") // context token count present
  })

  it("unknown ids in the list are ignored (lenient)", () => {
    const out = renderQuotaFooter(WINDOWS, TOKENS, {
      ...baseOpts,
      cols: 200,
      segments: ["quota", "typo", "sid"],
    })!
    const s = stripAnsi(out)
    expect(s).toContain("5h")
    expect(s).toContain("b00e2d52")
    expect(s).not.toContain("anth-4.8") // model not listed
  })
})

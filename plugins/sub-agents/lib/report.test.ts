/**
 * Tests for the pure `ReportResult` core: validating the model's input and
 * building the exact sentinel digest the handler persists.
 *
 * @module sub-agents/lib/report.test
 */

import { describe, expect, it } from "bun:test"

import { buildDigest, parseReportRequest, serializeDigest } from "./report.ts"
import { parseResultDigest } from "./spawn.ts"

describe("parseReportRequest", () => {
  it("requires a non-empty summary", () => {
    const r = parseReportRequest({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/summary/i)
  })

  it("accepts summary + artifacts + incomplete and trims", () => {
    const r = parseReportRequest({
      summary: "  found the bug in parser.ts  ",
      artifacts: ["/a.md", "  /b.md  ", "", 7],
      incomplete: true,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.summary).toBe("found the bug in parser.ts")
    expect(r.value.artifacts).toEqual(["/a.md", "/b.md"])
    expect(r.value.incomplete).toBe(true)
  })

  it("accepts natural aliases for summary (short/result/findings)", () => {
    expect(parseReportRequest({ short: "x" }).ok).toBe(true)
    expect(parseReportRequest({ result: "x" }).ok).toBe(true)
    expect(parseReportRequest({ findings: "x" }).ok).toBe(true)
  })

  it("omits artifacts when none are valid; defaults incomplete to false", () => {
    const r = parseReportRequest({ summary: "ok", artifacts: [] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.artifacts).toBeUndefined()
    expect(r.value.incomplete).toBeUndefined()
  })
})

describe("buildDigest", () => {
  it("builds a digest whose short carries the findings and artifacts", () => {
    const d = buildDigest({ summary: "the synthesis", artifacts: ["/x.md"], tokens: 10, tools: 3 })
    expect(d.short).toBe("the synthesis")
    expect(d.artifacts).toEqual(["/x.md"])
    expect(d.tokens).toBe(10)
    expect(d.tools).toBe(3)
  })

  it("prefixes INCOMPLETE: AND sets the structured incomplete flag", () => {
    const d = buildDigest({ summary: "got halfway", incomplete: true })
    expect(d.short).toBe("INCOMPLETE: got halfway")
    expect(d.incomplete).toBe(true)
    expect(d.tokens).toBe(0)
  })

  it("leaves incomplete unset for a normal (finished) report", () => {
    const d = buildDigest({ summary: "all done" })
    expect(d.incomplete).toBeUndefined()
  })

  it("round-trips through the SAME parser the supervisor probe uses", () => {
    // The handler serializes a digest; the probe's readResult parses it back.
    // They must agree, or a tool-reported result would not be readable.
    const d = buildDigest({ summary: "done it", artifacts: ["/r.md"], tokens: 5, tools: 2 })
    const json = serializeDigest(d)
    const reparsed = parseResultDigest(JSON.parse(json))
    expect(reparsed).toEqual(d)
  })

  it("round-trips the incomplete flag so the supervisor sees it", () => {
    const d = buildDigest({ summary: "blocked on auth", incomplete: true })
    const reparsed = parseResultDigest(JSON.parse(serializeDigest(d)))
    expect(reparsed?.incomplete).toBe(true)
  })
})

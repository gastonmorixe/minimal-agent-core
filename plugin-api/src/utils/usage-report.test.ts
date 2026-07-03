/**
 * Leaf usage-report helpers: the pure, host-free pieces a plugin consumes
 * (`parseUsagePeriod` argv parsing + the `emptyUsageReports` zeroed fixture).
 * The heavy scan/aggregate engine stays host-side in `src/quota/usage-stats`.
 */

import { describe, expect, it } from "bun:test"

import {
  emptyUsageReport,
  emptyUsageReports,
  parseUsagePeriod,
  USAGE_PERIODS,
} from "./usage-report.ts"

describe("parseUsagePeriod", () => {
  it("maps canonical ids", () => {
    expect(parseUsagePeriod("today")).toBe("today")
    expect(parseUsagePeriod("last-day")).toBe("last-day")
    expect(parseUsagePeriod("last-month")).toBe("last-month")
    expect(parseUsagePeriod("ytd")).toBe("ytd")
    expect(parseUsagePeriod("year")).toBe("year")
    expect(parseUsagePeriod("all")).toBe("all")
  })

  it("accepts aliases + is case/space insensitive", () => {
    expect(parseUsagePeriod("24h")).toBe("last-day")
    expect(parseUsagePeriod("30d")).toBe("last-month")
    expect(parseUsagePeriod("  ALL-TIME ")).toBe("all")
    expect(parseUsagePeriod("1y")).toBe("year")
  })

  it("returns null for empty / unknown", () => {
    expect(parseUsagePeriod(undefined)).toBeNull()
    expect(parseUsagePeriod("")).toBeNull()
    expect(parseUsagePeriod("nonsense")).toBeNull()
  })
})

describe("emptyUsageReport / emptyUsageReports", () => {
  it("emptyUsageReport is a zeroed report for the given period", () => {
    const r = emptyUsageReport("all", 1000)
    expect(r.period).toBe("all")
    expect(r.nowMs).toBe(1000)
    expect(r.totals.tokens).toBe(0)
    expect(r.totals.costUSD).toBe(0)
    expect(r.byProvider).toEqual([])
    expect(r.byModel).toEqual([])
    expect(r.estimated).toBe(false)
  })

  it("emptyUsageReports has one zeroed report per known period", () => {
    const all = emptyUsageReports(2000)
    for (const { id } of USAGE_PERIODS) {
      expect(all[id].period).toBe(id)
      expect(all[id].nowMs).toBe(2000)
      expect(all[id].totals.turns).toBe(0)
    }
  })
})

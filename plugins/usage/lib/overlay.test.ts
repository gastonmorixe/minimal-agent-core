import { describe, expect, it } from "bun:test"

import { stripAnsi } from "@minimal-agent/plugin-api/utils/term-width"

import { aggregateAllPeriods } from "../../../src/usage-stats.ts"

import {
  DEFAULT_PERIOD_INDEX,
  jumpIndex,
  periodAt,
  renderOverlayFrame,
  stepIndex,
  wrapIndex,
} from "./overlay.ts"

describe("index math", () => {
  it("wraps around the period range", () => {
    expect(wrapIndex(0)).toBe(0)
    expect(wrapIndex(6)).toBe(0) // 6 periods → wraps
    expect(wrapIndex(-1)).toBe(5)
  })

  it("steps forward / backward with wrap", () => {
    expect(stepIndex(0, 1)).toBe(1)
    expect(stepIndex(5, 1)).toBe(0)
    expect(stepIndex(0, -1)).toBe(5)
  })

  it("default index is All time (last)", () => {
    expect(periodAt(DEFAULT_PERIOD_INDEX)).toBe("all")
  })
})

describe("jumpIndex", () => {
  it("maps number keys 1-6 to 0-based indices", () => {
    expect(jumpIndex("1")).toBe(0)
    expect(jumpIndex("6")).toBe(5)
  })
  it("rejects out-of-range / non-numeric keys", () => {
    expect(jumpIndex("0")).toBeNull()
    expect(jumpIndex("7")).toBeNull()
    expect(jumpIndex("x")).toBeNull()
    expect(jumpIndex("ArrowLeft")).toBeNull()
  })
})

describe("renderOverlayFrame", () => {
  it("renders the active period's overlay from precomputed reports", () => {
    const reports = aggregateAllPeriods([], Date.now())
    const lines = renderOverlayFrame(reports, DEFAULT_PERIOD_INDEX, 80, 6)
    const text = stripAnsi(lines.join("\n"))
    expect(text).toContain("[All time]")
    expect(text).toContain("no usage recorded")
  })
})

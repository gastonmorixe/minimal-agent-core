/**
 * Pins for the neutral quota-summary renderer.
 *
 * Ported from the deleted `quota-format.test.ts` render cases so the
 * startup banner is byte-stable across the Phase-14 refactor: same
 * thresholds, same humanized resets, same separator, same lead spacing,
 * same opt-in overage segment. Inputs are neutral {@link QuotaWindow}s
 * (no header names anywhere — header parsing is provider-plugin turf,
 * tested in plugins/llm-anthropic/).
 */

import { describe, expect, it } from "bun:test"

import type { QuotaWindow } from "./llm/provider-plugin.ts"
import { formatQuotaWindows } from "./quota-summary.ts"

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

const NOW = 1_750_000_000_000
const now = () => NOW

function win(id: string, utilization: number, resetInMs?: number): QuotaWindow {
  return { id, utilization, resetAtMs: resetInMs === undefined ? undefined : NOW + resetInMs }
}

describe("formatQuotaWindows", () => {
  it("returns empty string for no windows", () => {
    expect(formatQuotaWindows([], { now })).toBe("")
  })

  it("renders one window with integer percent + humanized reset", () => {
    const out = stripAnsi(
      formatQuotaWindows([win("5h", 0.12, 3 * 3_600_000 + 12 * 60_000)], { now }),
    )
    expect(out).toBe("5h 12% ↻ 3h12m")
  })

  it("joins multiple windows with the dot separator, provider order preserved", () => {
    const out = stripAnsi(
      formatQuotaWindows(
        [
          win("5h", 0.12, 30 * 60_000),
          win("7d", 0.04, (2 * 24 + 6) * 3_600_000),
          win("overall", 0.09),
        ],
        { now },
      ),
    )
    expect(out).toBe("5h 12% ↻ 30m · 7d 4% ↻ 2d6h · overall 9%")
  })

  it("rounds utilization (0.099 → 10%, not 9.9%)", () => {
    expect(stripAnsi(formatQuotaWindows([win("5h", 0.099)], { now }))).toBe("5h 10%")
  })

  it("colors by threshold: green <60, yellow 60-84, red ≥85", () => {
    expect(formatQuotaWindows([win("a", 0.59)], { now })).toContain("\x1b[32m")
    expect(formatQuotaWindows([win("a", 0.6)], { now })).toContain("\x1b[33m")
    expect(formatQuotaWindows([win("a", 0.85)], { now })).toContain("\x1b[31m")
  })

  it("omits the reset chunk when the reset is in the past", () => {
    expect(stripAnsi(formatQuotaWindows([win("5h", 0.5, -60_000)], { now }))).toBe("5h 50%")
  })

  it("day-scale resets render as Nd / NdMh", () => {
    expect(stripAnsi(formatQuotaWindows([win("7d", 0.1, 3 * 24 * 3_600_000)], { now }))).toBe(
      "7d 10% ↻ 3d",
    )
    expect(stripAnsi(formatQuotaWindows([win("7d", 0.1, (3 * 24 + 5) * 3_600_000)], { now }))).toBe(
      "7d 10% ↻ 3d5h",
    )
  })

  it("applies leadSpaces", () => {
    expect(stripAnsi(formatQuotaWindows([win("5h", 0.2)], { now, leadSpaces: 2 }))).toBe("  5h 20%")
  })

  it("overage: silent by default, silent when active, red 'off' when opted in and inactive", () => {
    const wins = [win("5h", 0.2)]
    expect(stripAnsi(formatQuotaWindows(wins, { now, overage: { active: false } }))).toBe("5h 20%")
    expect(
      stripAnsi(formatQuotaWindows(wins, { now, showOverage: true, overage: { active: true } })),
    ).toBe("5h 20%")
    expect(
      stripAnsi(formatQuotaWindows(wins, { now, showOverage: true, overage: { active: false } })),
    ).toBe("5h 20% · overage off")
  })

  it("overage-only renders when opted in (parity with the old aggregate-less banner)", () => {
    expect(
      stripAnsi(formatQuotaWindows([], { now, showOverage: true, overage: { active: false } })),
    ).toBe("overage off")
  })
})

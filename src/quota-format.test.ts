/**
 * Unit tests for the pure `formatQuotaSummary` formatter.
 *
 * The formatter is shared by two callers — the synchronous startup row
 * and the live-area `quota-status` plugin slot — so its output must
 * stay byte-stable. These tests assert the structure (window order,
 * threshold-based color grading, reset-time humanization) without
 * pinning every ANSI byte; that would make the suite annoying to
 * maintain. We strip ANSI on the assert side and check the visible
 * shape.
 */

import { describe, expect, it } from "bun:test"

import { formatQuotaSummary } from "./quota-format.ts"

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("formatQuotaSummary", () => {
  it("returns empty string when given no headers", () => {
    expect(formatQuotaSummary(new Map())).toBe("")
  })

  it("returns empty string when none of the headers are recognized", () => {
    const rl = new Map([
      ["x-some-other-header", "0.5"],
      ["anthropic-something-unrelated", "ok"],
    ])
    expect(formatQuotaSummary(rl)).toBe("")
  })

  it("renders window-name + utilization% in stable narrow→wide order", () => {
    const rl = new Map([
      ["anthropic-ratelimit-unified-7d-utilization", "0.05"],
      ["anthropic-ratelimit-unified-5h-utilization", "0.42"],
      ["anthropic-ratelimit-unified-utilization", "0.30"],
    ])
    const out = stripAnsi(formatQuotaSummary(rl))
    // 5h must come before 7d, and the aggregate ("overall") last.
    expect(out.indexOf("5h")).toBeLessThan(out.indexOf("7d"))
    expect(out.indexOf("7d")).toBeLessThan(out.indexOf("overall"))
    expect(out).toContain("5h 42%")
    expect(out).toContain("7d 5%")
    expect(out).toContain("overall 30%")
  })

  it("color-grades pct: green <60, yellow 60-84, red ≥85", () => {
    const at = (util: number): string =>
      formatQuotaSummary(new Map([["anthropic-ratelimit-unified-5h-utilization", String(util)]]))
    // SGR 31=red, 33=yellow, 32=green (or boldRed/boldGreen variants).
    // Just check the color-byte family by ANSI prefix presence.
    expect(at(0.1)).toMatch(/\x1b\[(?:\d+;)?32m/)
    expect(at(0.7)).toMatch(/\x1b\[(?:\d+;)?33m/)
    expect(at(0.9)).toMatch(/\x1b\[(?:\d+;)?31m/)
  })

  it("rounds pct to integer (no sub-percent precision)", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.099"]])
    expect(stripAnsi(formatQuotaSummary(rl))).toContain("10%")
  })

  it("appends reset-time when reset header is present", () => {
    const now = 1_700_000_000_000
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.5"],
      // Reset 90 minutes from now (header is unix seconds).
      ["anthropic-ratelimit-unified-5h-reset", String(Math.floor((now + 90 * 60_000) / 1000))],
    ])
    expect(stripAnsi(formatQuotaSummary(rl, { now: () => now }))).toContain("1h30m")
  })

  it("omits the reset clause when reset is in the past", () => {
    const now = 1_700_000_000_000
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.5"],
      ["anthropic-ratelimit-unified-5h-reset", String(Math.floor((now - 60_000) / 1000))],
    ])
    expect(stripAnsi(formatQuotaSummary(rl, { now: () => now }))).not.toContain("↻")
  })

  it("formats long resets as days/hours and short resets as minutes", () => {
    const now = 1_700_000_000_000
    const at = (offsetMs: number): string => {
      const rl = new Map([
        ["anthropic-ratelimit-unified-7d-utilization", "0.5"],
        ["anthropic-ratelimit-unified-7d-reset", String(Math.floor((now + offsetMs) / 1000))],
      ])
      return stripAnsi(formatQuotaSummary(rl, { now: () => now }))
    }
    expect(at(45 * 60_000)).toContain("45m")
    expect(at((2 * 60 + 15) * 60_000)).toContain("2h15m")
    // 3 days exactly: "3d", not "3d0h"
    expect(at(3 * 24 * 60 * 60_000)).toContain("3d")
    expect(at(3 * 24 * 60 * 60_000)).not.toContain("3d0h")
    // 3d 5h: both shown
    expect(at((3 * 24 + 5) * 60 * 60_000)).toContain("3d5h")
  })

  it("hides overage by default — surfaces it only when opts.showOverage is true", () => {
    const allowed = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.5"],
      ["anthropic-ratelimit-unified-overage-status", "allowed"],
    ])
    const denied = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.5"],
      ["anthropic-ratelimit-unified-overage-status", "off"],
    ])
    // Default (opt-out): the overage segment never appears.
    expect(stripAnsi(formatQuotaSummary(allowed))).not.toContain("overage")
    expect(stripAnsi(formatQuotaSummary(denied))).not.toContain("overage")
    // Opt-in: surfaced only when status is something other than "allowed".
    expect(stripAnsi(formatQuotaSummary(allowed, { showOverage: true }))).not.toContain("overage")
    expect(stripAnsi(formatQuotaSummary(denied, { showOverage: true }))).toContain("overage off")
  })

  it("ignores `overage`/`fallback`/`representative` window names entirely", () => {
    const rl = new Map([
      ["anthropic-ratelimit-unified-overage-utilization", "0.99"],
      ["anthropic-ratelimit-unified-fallback-utilization", "0.99"],
      ["anthropic-ratelimit-unified-representative-utilization", "0.99"],
      ["anthropic-ratelimit-unified-5h-utilization", "0.10"],
    ])
    const out = stripAnsi(formatQuotaSummary(rl))
    // None of the noisy synthetic windows should leak into the visible string.
    expect(out).not.toMatch(/\b(?:overage 99%|fallback|representative)\b/)
    expect(out).toContain("5h 10%")
  })

  it("respects leadSpaces (startup path uses 2, live-area uses 0)", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    expect(formatQuotaSummary(rl, { leadSpaces: 0 }).startsWith(" ")).toBe(false)
    expect(formatQuotaSummary(rl, { leadSpaces: 2 }).startsWith("  ")).toBe(true)
  })

  it("uses ` · ` as a mid-dot separator between windows", () => {
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.10"],
      ["anthropic-ratelimit-unified-7d-utilization", "0.05"],
    ])
    expect(stripAnsi(formatQuotaSummary(rl))).toMatch(/5h 10% · 7d 5%/)
  })
})

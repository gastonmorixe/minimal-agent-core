/**
 * Visual-shape tests for the new footer renderer. ANSI is stripped on
 * the assert side. We pin the structure (no leading "quota" word, bar
 * shapes, session segment, overage opt-in, responsive degradation),
 * not specific SGR bytes.
 */

import { describe, expect, it } from "bun:test"
import type { SessionTokens } from "../../src/session-tokens.ts"
import { renderQuotaFooter } from "./render.ts"

const stripAnsi = (s: string | null): string =>
  (s ?? "").replace(/\x1b\[[0-9;]*m/g, "")

const NO_TOKENS: SessionTokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  total: 0,
  turns: 0,
}
const SOME_TOKENS: SessionTokens = {
  input: 12_400,
  output: 8_100,
  cacheRead: 35_000,
  cacheCreate: 3_000,
  total: 58_500,
  turns: 3,
}

describe("renderQuotaFooter", () => {
  it("returns null when there is nothing to render", () => {
    expect(renderQuotaFooter(new Map(), NO_TOKENS)).toBeNull()
  })

  it("never starts with the word 'quota'", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.21"]])
    const out = stripAnsi(renderQuotaFooter(rl, SOME_TOKENS))
    expect(out.startsWith("quota")).toBe(false)
    // The first char must be one of the bar fill glyphs.
    const BAR_GLYPHS = new Set(["█", "░", "▏", "▎", "▍", "▌", "▋", "▊", "▉"])
    expect(BAR_GLYPHS.has(out[0]!)).toBe(true)
  })

  it("uses an 8-cell bar (fill + empty glyphs sum to 8 per window)", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.5"]])
    const out = stripAnsi(renderQuotaFooter(rl, NO_TOKENS))
    const lead = out.match(/^[█▏▎▍▌▋▊▉░]+/)![0]
    expect(lead.length).toBe(8)
  })

  it("renders the percent right after the bar, then the window name", () => {
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
      ["anthropic-ratelimit-unified-7d-utilization", "0.08"],
    ])
    const out = stripAnsi(renderQuotaFooter(rl, NO_TOKENS))
    expect(out).toMatch(/[█▏▎▍▌▋▊▉░]{8} 21% 5h/)
    expect(out).toMatch(/[█▏▎▍▌▋▊▉░]{8} 8% 7d/)
    // 5h must precede 7d.
    expect(out.indexOf("5h")).toBeLessThan(out.indexOf("7d"))
  })

  it("appends the reset countdown as a dim trailing word (no ↻ icon)", () => {
    const now = 1_700_000_000_000
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
      [
        "anthropic-ratelimit-unified-5h-reset",
        String(Math.floor((now + 90 * 60_000) / 1000)),
      ],
    ])
    const out = stripAnsi(renderQuotaFooter(rl, NO_TOKENS, { now: () => now }))
    expect(out).toContain("1h30m")
    expect(out).not.toContain("↻")
  })

  it("appends the session block with ✦ and bold total when traffic exists", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const out = stripAnsi(renderQuotaFooter(rl, SOME_TOKENS))
    expect(out).toContain("✦")
    expect(out).toContain("58.5k")
    expect(out).toContain("tok")
    expect(out).toContain("38k cached") // cacheRead + cacheCreate = 35k + 3k
  })

  it("omits the session block when total is zero (no API traffic yet)", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const out = stripAnsi(renderQuotaFooter(rl, NO_TOKENS))
    expect(out).not.toContain("✦")
    expect(out).not.toContain("tok")
  })

  it("hides 'overage' by default", () => {
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.10"],
      ["anthropic-ratelimit-unified-overage-status", "off"],
    ])
    expect(stripAnsi(renderQuotaFooter(rl, NO_TOKENS))).not.toContain("overage")
  })

  it("surfaces 'overage off' only when showOverage: true and status != allowed", () => {
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.10"],
      ["anthropic-ratelimit-unified-overage-status", "off"],
    ])
    const out = stripAnsi(
      renderQuotaFooter(rl, NO_TOKENS, { showOverage: true }),
    )
    expect(out).toContain("overage")
    expect(out).toContain("off")
  })

  it("hides overage even with showOverage: true when status is 'allowed'", () => {
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.10"],
      ["anthropic-ratelimit-unified-overage-status", "allowed"],
    ])
    expect(
      stripAnsi(renderQuotaFooter(rl, NO_TOKENS, { showOverage: true })),
    ).not.toContain("overage")
  })

  it("color-grades the bar (green <60, yellow 60-84, red >=85)", () => {
    const at = (util: number) =>
      renderQuotaFooter(
        new Map([["anthropic-ratelimit-unified-5h-utilization", String(util)]]),
        NO_TOKENS,
      ) ?? ""
    // SGR 31=red, 33=yellow, 32=green.
    expect(at(0.1)).toMatch(/\x1b\[(?:\d+;)?32m/)
    expect(at(0.7)).toMatch(/\x1b\[(?:\d+;)?33m/)
    expect(at(0.9)).toMatch(/\x1b\[(?:\d+;)?31m/)
  })

  it("degrades responsively when cols is tight: drops cached → session → reset → 7d", () => {
    const now = 1_700_000_000_000
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
      [
        "anthropic-ratelimit-unified-5h-reset",
        String(Math.floor((now + 90 * 60_000) / 1000)),
      ],
      ["anthropic-ratelimit-unified-7d-utilization", "0.08"],
      [
        "anthropic-ratelimit-unified-7d-reset",
        String(Math.floor((now + 6 * 24 * 3600 * 1000) / 1000)),
      ],
    ])
    const wide = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { cols: 200, now: () => now }),
    )
    const mid = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { cols: 50, now: () => now }),
    )
    const tight = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { cols: 25, now: () => now }),
    )

    // Wide: everything visible.
    expect(wide).toContain("cached")
    expect(wide).toContain("✦")
    expect(wide).toContain("7d")
    expect(wide).toContain("1h30m")

    // Mid: cached gone, maybe session+7d still in.
    expect(mid).not.toContain("cached")
    expect(mid.length).toBeLessThanOrEqual(50 + 1)

    // Tight: only the 5h bar.
    expect(tight).toContain("5h")
    expect(tight).not.toContain("7d")
    expect(tight).not.toContain("✦")
  })

  it("fmtTokens rounds .0 cleanly (e.g. 1000 → '1k', not '1.0k')", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const sess: SessionTokens = { ...NO_TOKENS, total: 1_000, turns: 1 }
    const out = stripAnsi(renderQuotaFooter(rl, sess))
    expect(out).toContain("1k")
    expect(out).not.toContain("1.0k")
  })

  it("fmtTokens uses M suffix at >=1M", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const sess: SessionTokens = { ...NO_TOKENS, total: 2_500_000, turns: 1 }
    const out = stripAnsi(renderQuotaFooter(rl, sess))
    expect(out).toContain("2.5M")
  })

  it("omits reset clause when reset is in the past", () => {
    const now = 1_700_000_000_000
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.10"],
      [
        "anthropic-ratelimit-unified-5h-reset",
        String(Math.floor((now - 60_000) / 1000)),
      ],
    ])
    const out = stripAnsi(renderQuotaFooter(rl, NO_TOKENS, { now: () => now }))
    // No countdown word should appear — bar + pct + label only.
    expect(out).toMatch(/[█▏▎▍▌▋▊▉░]{8} 10% 5h$/)
  })
})

/**
 * Visual-shape tests for the footer renderer. ANSI is stripped on the
 * assert side. We pin the structure (no leading "quota" word, bar
 * shapes, session segment with its own bar, overage opt-in, responsive
 * degradation), not specific SGR bytes.
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
  contextSize: 0,
}
const SOME_TOKENS: SessionTokens = {
  input: 12_400,
  output: 8_100,
  cacheRead: 35_000,
  cacheCreate: 3_000,
  total: 58_500,
  turns: 3,
  // Latest turn's input footprint — what the ✦ segment displays.
  // Distinct from `total` to make the new contract obvious.
  contextSize: 47_500,
}

describe("renderQuotaFooter", () => {
  it("returns null when there is nothing to render (no windows, session off)", () => {
    expect(
      renderQuotaFooter(new Map(), NO_TOKENS, { showSession: false }),
    ).toBeNull()
  })

  it("renders the session block even when there are no quota windows", () => {
    // Pre-traffic, before the first response arrives, we still want users
    // to see their context budget signpost (✦ ░░░░░░░░ 0% 0 ctx).
    const out = stripAnsi(renderQuotaFooter(new Map(), NO_TOKENS))
    expect(out).toContain("✦")
    expect(out).toContain("ctx")
    expect(out).toContain("0%")
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
    const out = stripAnsi(renderQuotaFooter(rl, NO_TOKENS, { showSession: false }))
    const lead = out.match(/^[█▏▎▍▌▋▊▉░]+/)![0]
    expect(lead.length).toBe(8)
  })

  it("renders the percent right after the bar, then the window name", () => {
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
      ["anthropic-ratelimit-unified-7d-utilization", "0.08"],
    ])
    const out = stripAnsi(renderQuotaFooter(rl, NO_TOKENS, { showSession: false }))
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
    const out = stripAnsi(
      renderQuotaFooter(rl, NO_TOKENS, { now: () => now, showSession: false }),
    )
    expect(out).toContain("1h30m")
    expect(out).not.toContain("↻")
  })

  it("appends the session block with ✦, an 8-cell bar, %, contextSize, and 'ctx'", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const out = stripAnsi(renderQuotaFooter(rl, SOME_TOKENS))
    expect(out).toContain("✦")
    expect(out).toContain("47.5k")
    expect(out).toContain("ctx")
    // 47.5k / 200k = 23.75% → rounds to 24%
    expect(out).toContain("24%")
    // The session bar is also an 8-cell strip: ✦ <bar><pct> ...
    expect(out).toMatch(/✦ [█▏▎▍▌▋▊▉░]{8} 24% 47\.5k ctx/)
    // The "N cached" sub-segment is gone (would inherit the inflation).
    expect(out).not.toContain("cached")
  })

  it("uses contextSize (not the inflated cumulative `total`) for the displayed number", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const out = stripAnsi(renderQuotaFooter(rl, SOME_TOKENS))
    // `total` is 58_500 in SOME_TOKENS but contextSize is 47_500.
    expect(out).toContain("47.5k")
    expect(out).not.toContain("58.5k")
  })

  it("ALWAYS shows the session block — even when contextSize is 0", () => {
    // User-facing requirement: from the very first paint (before any API
    // response), the context-budget signpost should be visible.
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const out = stripAnsi(renderQuotaFooter(rl, NO_TOKENS))
    expect(out).toContain("✦")
    expect(out).toContain("ctx")
    expect(out).toContain("0%")
    // The bar at 0% is all-empty cells.
    expect(out).toMatch(/✦ [░]{8} 0% 0 ctx/)
  })

  it("honors contextWindow opt (1M model context → smaller fill % for the same tokens)", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const out200k = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { contextWindow: 200_000 }),
    )
    const out1m = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { contextWindow: 1_000_000 }),
    )
    expect(out200k).toContain("24%") // 47.5k / 200k
    expect(out1m).toContain("5%") //   47.5k / 1M
    // The displayed token count is identical — only the % changes.
    expect(out200k).toContain("47.5k")
    expect(out1m).toContain("47.5k")
  })

  it("clamps the session bar % at 100 when contextSize overshoots the window", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const huge: SessionTokens = { ...NO_TOKENS, contextSize: 250_000, turns: 1 }
    const out = stripAnsi(
      renderQuotaFooter(rl, huge, { contextWindow: 200_000 }),
    )
    expect(out).toContain("100%")
  })

  it("color-grades the session bar like the quota bars (green/yellow/red)", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.0"]])
    const ctx = 200_000
    const at = (frac: number) => {
      const s: SessionTokens = { ...NO_TOKENS, contextSize: Math.floor(frac * ctx) }
      return renderQuotaFooter(rl, s, { contextWindow: ctx }) ?? ""
    }
    // SGR 31=red, 33=yellow, 32=green.
    expect(at(0.1)).toMatch(/\x1b\[(?:\d+;)?32m/)
    expect(at(0.7)).toMatch(/\x1b\[(?:\d+;)?33m/)
    expect(at(0.9)).toMatch(/\x1b\[(?:\d+;)?31m/)
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

  it("color-grades the quota bar (green <60, yellow 60-84, red >=85)", () => {
    const at = (util: number) =>
      renderQuotaFooter(
        new Map([["anthropic-ratelimit-unified-5h-utilization", String(util)]]),
        NO_TOKENS,
        { showSession: false },
      ) ?? ""
    // SGR 31=red, 33=yellow, 32=green.
    expect(at(0.1)).toMatch(/\x1b\[(?:\d+;)?32m/)
    expect(at(0.7)).toMatch(/\x1b\[(?:\d+;)?33m/)
    expect(at(0.9)).toMatch(/\x1b\[(?:\d+;)?31m/)
  })

  it("degrades responsively: bar drops first, then reset, then session, then 7d", () => {
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
    const tight = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { cols: 25, now: () => now }),
    )

    // Wide: everything visible, including the session bar.
    expect(wide).toContain("✦")
    expect(wide).toContain("ctx")
    expect(wide).toContain("24%") // session bar percent
    expect(wide).toContain("7d")
    expect(wide).toContain("1h30m")

    // Tight: only the 5h bar.
    expect(tight).toContain("5h")
    expect(tight).not.toContain("7d")
    expect(tight).not.toContain("✦")
  })

  it("drops the session bar but keeps `✦ N ctx` at medium widths", () => {
    const now = 1_700_000_000_000
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
      ["anthropic-ratelimit-unified-7d-utilization", "0.08"],
    ])
    // Wide enough for both bars + session text, but not for the session bar.
    const mid = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { cols: 55, now: () => now }),
    )
    expect(mid.length).toBeLessThanOrEqual(55 + 1)
    expect(mid).toContain("5h")
    expect(mid).toContain("7d")
    expect(mid).toContain("✦")
    expect(mid).toContain("ctx")
    // The session bar's `24%` should be gone (bar dropped); the quota bars
    // still keep their own percents.
    expect(mid).toContain("47.5k")
  })

  it("fmtTokens rounds .0 cleanly (e.g. 1000 → '1k', not '1.0k')", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const sess: SessionTokens = { ...NO_TOKENS, contextSize: 1_000, turns: 1 }
    const out = stripAnsi(renderQuotaFooter(rl, sess))
    expect(out).toContain("1k")
    expect(out).not.toContain("1.0k")
  })

  it("fmtTokens uses M suffix at >=1M", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const sess: SessionTokens = { ...NO_TOKENS, contextSize: 2_500_000, turns: 1 }
    const out = stripAnsi(
      renderQuotaFooter(rl, sess, { contextWindow: 1_000_000 }),
    )
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
    const out = stripAnsi(
      renderQuotaFooter(rl, NO_TOKENS, { now: () => now, showSession: false }),
    )
    // No countdown word should appear — bar + pct + label only.
    expect(out).toMatch(/[█▏▎▍▌▋▊▉░]{8} 10% 5h$/)
  })

  it("respects showSession: false (suppresses the block even with traffic)", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const out = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { showSession: false }),
    )
    expect(out).not.toContain("✦")
    expect(out).not.toContain("ctx")
  })
})

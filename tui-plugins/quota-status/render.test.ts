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

  it("renders the session block even when there are no quota windows (known window)", () => {
    // Pre-traffic, before the first response arrives, we still want users
    // to see their context-budget signpost (`200k ░░░░░░░░ 0% 0`).
    const out = stripAnsi(
      renderQuotaFooter(new Map(), NO_TOKENS, { contextWindow: 200_000 }),
    )
    // `✦` was retired — the size label is the session marker.
    expect(out).not.toContain("✦")
    // Context window is the LEFT label (parallel slot to 5h/7d).
    expect(out).toContain("200k")
    expect(out).toContain("0%")
    // Trailing count `0` appears after the percent (word-boundary safe).
    expect(out).toMatch(/0% 0\b/)
    // With a known window the placeholder `·` does NOT appear in the
    // session slot — that's reserved for the unknown-window fallback.
    expect(out).not.toContain("·")
  })

  it("renders a `·` placeholder for the session block when context window is unknown", () => {
    // No `contextWindow` opt → renderer can't compute a fill % → drops
    // the bar+percent and uses a dim middle-dot as the label. The
    // trailing token count still renders.
    const out = stripAnsi(renderQuotaFooter(new Map(), NO_TOKENS))
    expect(out).toContain("·") // placeholder for unknown window
    expect(out).not.toContain("0%") // no percent without a denominator
    expect(out).not.toContain("200k") // no implicit default value
    expect(out).not.toContain("1M")
    // Shape: just `· 0` (label + trailing count).
    expect(out).toMatch(/· 0$/)
  })

  it("never starts with the word 'quota'", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.21"]])
    const out = stripAnsi(renderQuotaFooter(rl, SOME_TOKENS))
    expect(out.startsWith("quota")).toBe(false)
    // A2: first char is the window NAME label, not a bar glyph.
    expect(out.startsWith("5h ")).toBe(true)
  })

  it("uses an 8-cell bar (fill + empty glyphs sum to 8 per window)", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.5"]])
    const out = stripAnsi(renderQuotaFooter(rl, NO_TOKENS, { showSession: false }))
    // The bar follows the window-name label (`5h `) — extract by matching
    // the first run of bar glyphs anywhere in the line.
    const m = out.match(/[█▏▎▍▌▋▊▉░]+/)
    expect(m).not.toBeNull()
    expect(m![0].length).toBe(8)
  })

  it("renders the window name LEFT of the bar, then bar + percent", () => {
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
      ["anthropic-ratelimit-unified-7d-utilization", "0.08"],
    ])
    const out = stripAnsi(renderQuotaFooter(rl, NO_TOKENS, { showSession: false }))
    // A2 layout: `<name> <bar> <pct>` — name leads.
    expect(out).toMatch(/5h [█▏▎▍▌▋▊▉░]{8} 21%/)
    expect(out).toMatch(/7d [█▏▎▍▌▋▊▉░]{8} 8%/)
    // 5h must precede 7d.
    expect(out.indexOf("5h")).toBeLessThan(out.indexOf("7d"))
  })

  it("appends the reset countdown as a trailing dim duration (no · separator, no ↻ icon)", () => {
    const now = 1_700_000_000_000
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
      [
        "anthropic-ratelimit-unified-5h-reset",
        String(Math.floor((now + 90 * 60_000) / 1000)),
      ],
    ])
    // `showSession: false` so the session block (which can carry a `·`
    // placeholder when context window is unknown) doesn't leak into
    // this assertion.
    const out = stripAnsi(
      renderQuotaFooter(rl, NO_TOKENS, { now: () => now, showSession: false }),
    )
    // Shape: `<name> <bar> <pct> <reset>` — single-space gaps everywhere.
    // The dim color of the reset countdown is enough visual separation
    // from the bold-colored percent; no `·` middle-dot, no `↻` icon.
    expect(out).toMatch(/21% 1h30m/)
    expect(out).not.toContain("·")
    expect(out).not.toContain("↻")
  })

  it("appends the session block as `<size> <bar> <pct> <used>` (structurally identical to quota)", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const out = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { contextWindow: 200_000 }),
    )
    expect(out).not.toContain("✦")
    expect(out).toContain("47.5k")
    // 47.5k / 200k = 23.75% → rounds to 24%
    expect(out).toContain("24%")
    // Shape: `<size> <8-cell-bar> <pct> <used>`. Size label (`200k`) is
    // the LEFT slot — parallel role to 5h/7d, with the formatted
    // context-window as the magnitude. Used count trails (parallel to
    // the quota reset countdown slot). No `/`.
    expect(out).toMatch(/200k [█▏▎▍▌▋▊▉░]{8} 24% 47\.5k/)
    expect(out).not.toContain("/")
    // With a known window the `·` placeholder is NOT used.
    expect(out).not.toContain("·")
    // The "N cached" sub-segment is gone (would inherit the inflation).
    expect(out).not.toContain("cached")
    // The trailing word `ctx` was retired.
    expect(out).not.toMatch(/ ctx\b/)
  })

  it("uses contextSize (not the inflated cumulative `total`) for the displayed number", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const out = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { contextWindow: 200_000 }),
    )
    // `total` is 58_500 in SOME_TOKENS but contextSize is 47_500.
    expect(out).toContain("47.5k")
    expect(out).not.toContain("58.5k")
  })

  it("ALWAYS shows the session block — even when contextSize is 0", () => {
    // User-facing requirement: from the very first paint (before any API
    // response), the context-budget signpost should be visible.
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const out = stripAnsi(
      renderQuotaFooter(rl, NO_TOKENS, { contextWindow: 200_000 }),
    )
    expect(out).not.toContain("✦")
    expect(out).toContain("0%")
    // Bar at 0% is all-empty cells. Size label leads, trailing `0` count.
    expect(out).toMatch(/200k [░]{8} 0% 0\b/)
  })

  it("trailing count is bold when contextSize > 0, dim when = 0", () => {
    // User-visible requirement: the live count is the actionable bit on
    // the footer (it grows as you work). Once it's > 0 it must NOT be
    // faint. The zero state can stay quiet — there's no live data to
    // emphasise, and parallel to 5h/7d's dim pre-traffic shape.
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const opts = { contextWindow: 200_000 }
    const live = renderQuotaFooter(rl, SOME_TOKENS, opts) ?? ""
    const cold = renderQuotaFooter(rl, NO_TOKENS, opts) ?? ""
    // Bold SGR opener (\x1b[1m) wraps the live numerator.
    expect(live).toContain("\x1b[1m47.5k\x1b[22m")
    // Live numerator is NOT inside a faintWhite wrap (faintWhite is
    // reserved for the size label and quota labels like 5h/7d).
    expect(live).not.toContain("\x1b[2;37m47.5k")
    // Cold trailing `0` IS dim (the trailing count uses c.dim — just
    // dim, no white-fg modifier).
    expect(cold).toContain("\x1b[2m0\x1b[22m")
  })

  it("renders no `·` (middle-dot) on the quota segments — single-space + dim color is enough", () => {
    // Regression guard for the quota segments: `·` used to sit before
    // the reset countdown ("21% · 1h30m") and was retired. The session
    // segment can carry `·` as its placeholder label when the context
    // window is unknown, so this guard is scoped to a
    // `showSession: false` render.
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
        String(Math.floor((now + 6 * 86400_000) / 1000)),
      ],
    ])
    const out = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { now: () => now, showSession: false }),
    )
    expect(out).not.toContain("·")
  })

  it("uses the formatted context-window as the session label when known (`200k`, `1M`, ...)", () => {
    // The session segment's LEFT slot is parallel to 5h/7d — each
    // segment's label says what its bar represents. For session that's
    // the model's context window magnitude, formatted compactly so the
    // user can see at a glance whether they're on 200k or 1M.
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const out200k = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { contextWindow: 200_000 }),
    )
    const out1m = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { contextWindow: 1_000_000 }),
    )
    const out500k = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { contextWindow: 500_000 }),
    )
    // Size label precedes the session bar (after the 4-space group separator).
    expect(out200k).toMatch(/ {4}200k [█▏▎▍▌▋▊▉░]{8}/)
    expect(out1m).toMatch(/ {4}1M [█▏▎▍▌▋▊▉░]{8}/)
    expect(out500k).toMatch(/ {4}500k [█▏▎▍▌▋▊▉░]{8}/)
    // No `·` placeholder when the window is known.
    expect(out200k).not.toContain("·")
    expect(out1m).not.toContain("·")
    expect(out500k).not.toContain("·")
  })

  it("uses faintWhite for the size label (same tier as 5h/7d quota labels)", () => {
    // Visual-tier check: the size label sits at the same intensity as
    // the quota labels so the three segments read as a row of peers.
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const live = renderQuotaFooter(rl, SOME_TOKENS, { contextWindow: 200_000 }) ?? ""
    // faintWhite is `\x1b[2;37m...\x1b[22;39m` (dim + white fg).
    expect(live).toContain("\x1b[2;37m200k\x1b[22;39m")
    expect(live).toContain("\x1b[2;37m5h\x1b[22;39m")
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
    // Both labels now reflect the resolved window magnitude.
    expect(out200k).toContain("200k")
    expect(out1m).toContain("1M")
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
      renderQuotaFooter(rl, SOME_TOKENS, {
        cols: 200,
        now: () => now,
        contextWindow: 200_000,
      }),
    )
    const tight = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, {
        cols: 25,
        now: () => now,
        contextWindow: 200_000,
      }),
    )

    // Wide: everything visible, including the session bar.
    expect(wide).not.toContain("✦")
    expect(wide).not.toContain("/") // no slash anywhere
    expect(wide).toContain("200k") // size label (LEFT slot)
    expect(wide).toContain("47.5k") // used count (trailing)
    expect(wide).toContain("24%") // session bar percent
    expect(wide).toContain("7d")
    expect(wide).toContain("1h30m")
    // No trailing `ctx` word.
    expect(wide).not.toMatch(/ ctx\b/)

    // Tight: only the 5h bar.
    expect(tight).toContain("5h")
    expect(tight).not.toContain("7d")
    expect(tight).not.toContain("47.5k")
  })

  it("drops the session bar but keeps the trailing count at medium widths", () => {
    const now = 1_700_000_000_000
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
      ["anthropic-ratelimit-unified-7d-utilization", "0.08"],
    ])
    // Wide enough for both bars + session text, but not for the session bar.
    const mid = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, {
        cols: 55,
        now: () => now,
        contextWindow: 200_000,
      }),
    )
    expect(mid.length).toBeLessThanOrEqual(55 + 1)
    expect(mid).toContain("5h")
    expect(mid).toContain("7d")
    expect(mid).not.toContain("✦")
    // Bar-dropped session segment is JUST the live count — the size
    // label loses its purpose without the bar's "fraction of this"
    // reading, and the percent is also gone with the bar.
    expect(mid).toContain("47.5k")
    expect(mid).not.toContain("200k") // size label dropped with the bar
    expect(mid).not.toContain("24%") // session percent dropped with the bar
    expect(mid).not.toContain("/") // no slash anywhere
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
    // A2: no countdown clause — `<name> <bar> <pct>` with nothing trailing.
    expect(out).toMatch(/5h [█▏▎▍▌▋▊▉░]{8} 10%$/)
  })

  it("respects showSession: false (suppresses the block even with traffic)", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    const out = stripAnsi(
      renderQuotaFooter(rl, SOME_TOKENS, { showSession: false }),
    )
    expect(out).not.toContain("✦")
    // The live count `47.5k` is the unambiguous session marker. Its
    // absence confirms the block was suppressed. (The `·` label alone
    // wouldn't be a reliable absence-check — it could appear anywhere.)
    expect(out).not.toContain("47.5k")
  })
})

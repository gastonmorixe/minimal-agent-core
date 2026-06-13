/**
 * Visual-shape tests for the footer renderer. ANSI is stripped on the
 * assert side. We pin the structure (no leading "quota" word, bar
 * shapes, session segment with its own bar, overage opt-in, responsive
 * degradation), not specific SGR bytes.
 *
 * Input is the provider-neutral `QuotaWindow[]` DTO. Header PARSING is
 * a provider concern and is covered where the parser lives
 * (`plugins/llm-anthropic/session-info*.test.ts`) — nothing here knows
 * about `anthropic-ratelimit-*` headers.
 */

import { describe, expect, it } from "bun:test"

import type { QuotaWindow } from "@minimal-agent/plugin-api/llm/provider-plugin"

import type { SessionTokens } from "./host-types.ts"
import { renderQuotaFooter } from "./render.ts"

const stripAnsi = (s: string | null): string => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "")

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
    expect(renderQuotaFooter([], NO_TOKENS, { showSession: false })).toBeNull()
  })

  it("renders the session block even when there are no quota windows (known window)", () => {
    // Pre-traffic, before the first response arrives, we still want users
    // to see their context-budget signpost (`200k ░░░░░░░░ 0% 0`).
    const out = stripAnsi(renderQuotaFooter([], NO_TOKENS, { contextWindow: 200_000 }))
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
    const out = stripAnsi(renderQuotaFooter([], NO_TOKENS))
    expect(out).toContain("·") // placeholder for unknown window
    expect(out).not.toContain("0%") // no percent without a denominator
    expect(out).not.toContain("200k") // no implicit default value
    expect(out).not.toContain("1M")
    // Shape: just `· 0` (label + trailing count).
    expect(out).toMatch(/· 0$/)
  })

  it("never starts with the word 'quota'", () => {
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.21 }]
    const out = stripAnsi(renderQuotaFooter(windows, SOME_TOKENS))
    expect(out.startsWith("quota")).toBe(false)
    // A2: first char is the window NAME label, not a bar glyph.
    expect(out.startsWith("5h ")).toBe(true)
  })

  it("uses an 8-cell bar (fill + empty glyphs sum to 8 per window)", () => {
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.5 }]
    const out = stripAnsi(renderQuotaFooter(windows, NO_TOKENS, { showSession: false }))
    // The bar follows the window-name label (`5h `) — extract by matching
    // the first run of bar glyphs anywhere in the line.
    const m = out.match(/[█▏▎▍▌▋▊▉░]+/)
    expect(m).not.toBeNull()
    expect(m![0].length).toBe(8)
  })

  it("renders the window name LEFT of the bar, then bar + percent", () => {
    const windows: QuotaWindow[] = [
      { id: "5h", utilization: 0.21 },
      { id: "7d", utilization: 0.08 },
    ]
    const out = stripAnsi(renderQuotaFooter(windows, NO_TOKENS, { showSession: false }))
    // A2 layout: `<name> <bar> <pct>` — name leads.
    expect(out).toMatch(/5h [█▏▎▍▌▋▊▉░]{8} 21%/)
    expect(out).toMatch(/7d [█▏▎▍▌▋▊▉░]{8} 8%/)
    // 5h must precede 7d (windows render in provider-given order).
    expect(out.indexOf("5h")).toBeLessThan(out.indexOf("7d"))
  })

  it("appends the reset countdown as a trailing dim duration (no · separator, no ↻ icon)", () => {
    const now = 1_700_000_000_000
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.21, resetAtMs: now + 90 * 60_000 }]
    // `showSession: false` so the session block (which can carry a `·`
    // placeholder when context window is unknown) doesn't leak into
    // this assertion.
    const out = stripAnsi(
      renderQuotaFooter(windows, NO_TOKENS, { now: () => now, showSession: false }),
    )
    // Shape: `<name> <bar> <pct> <reset>` — single-space gaps everywhere.
    // The dim color of the reset countdown is enough visual separation
    // from the bold-colored percent; no `·` middle-dot, no `↻` icon.
    expect(out).toMatch(/21% 1h30m/)
    expect(out).not.toContain("·")
    expect(out).not.toContain("↻")
  })

  it("appends the session block as `<size> <bar> <pct> <used>` (structurally identical to quota)", () => {
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    const out = stripAnsi(renderQuotaFooter(windows, SOME_TOKENS, { contextWindow: 200_000 }))
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
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    const out = stripAnsi(renderQuotaFooter(windows, SOME_TOKENS, { contextWindow: 200_000 }))
    // `total` is 58_500 in SOME_TOKENS but contextSize is 47_500.
    expect(out).toContain("47.5k")
    expect(out).not.toContain("58.5k")
  })

  it("ALWAYS shows the session block — even when contextSize is 0", () => {
    // User-facing requirement: from the very first paint (before any API
    // response), the context-budget signpost should be visible.
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    const out = stripAnsi(renderQuotaFooter(windows, NO_TOKENS, { contextWindow: 200_000 }))
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
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    const opts = { contextWindow: 200_000 }
    const live = renderQuotaFooter(windows, SOME_TOKENS, opts) ?? ""
    const cold = renderQuotaFooter(windows, NO_TOKENS, opts) ?? ""
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
    const windows: QuotaWindow[] = [
      { id: "5h", utilization: 0.21, resetAtMs: now + 90 * 60_000 },
      { id: "7d", utilization: 0.08, resetAtMs: now + 6 * 86_400_000 },
    ]
    const out = stripAnsi(
      renderQuotaFooter(windows, SOME_TOKENS, { now: () => now, showSession: false }),
    )
    expect(out).not.toContain("·")
  })

  it("uses the formatted context-window as the session label when known (`200k`, `1M`, ...)", () => {
    // The session segment's LEFT slot is parallel to 5h/7d — each
    // segment's label says what its bar represents. For session that's
    // the model's context window magnitude, formatted compactly so the
    // user can see at a glance whether they're on 200k or 1M.
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    const out200k = stripAnsi(renderQuotaFooter(windows, SOME_TOKENS, { contextWindow: 200_000 }))
    const out1m = stripAnsi(renderQuotaFooter(windows, SOME_TOKENS, { contextWindow: 1_000_000 }))
    const out500k = stripAnsi(renderQuotaFooter(windows, SOME_TOKENS, { contextWindow: 500_000 }))
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
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    const live = renderQuotaFooter(windows, SOME_TOKENS, { contextWindow: 200_000 }) ?? ""
    // faintWhite is `\x1b[2;37m...\x1b[22;39m` (dim + white fg).
    expect(live).toContain("\x1b[2;37m200k\x1b[22;39m")
    expect(live).toContain("\x1b[2;37m5h\x1b[22;39m")
  })

  it("honors contextWindow opt (1M model context → smaller fill % for the same tokens)", () => {
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    const out200k = stripAnsi(renderQuotaFooter(windows, SOME_TOKENS, { contextWindow: 200_000 }))
    const out1m = stripAnsi(renderQuotaFooter(windows, SOME_TOKENS, { contextWindow: 1_000_000 }))
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
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    const huge: SessionTokens = { ...NO_TOKENS, contextSize: 250_000, turns: 1 }
    const out = stripAnsi(renderQuotaFooter(windows, huge, { contextWindow: 200_000 }))
    expect(out).toContain("100%")
  })

  it("color-grades the session bar like the quota bars (green/yellow/red)", () => {
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.0 }]
    const ctx = 200_000
    const at = (frac: number) => {
      const s: SessionTokens = { ...NO_TOKENS, contextSize: Math.floor(frac * ctx) }
      return renderQuotaFooter(windows, s, { contextWindow: ctx }) ?? ""
    }
    // SGR 31=red, 33=yellow, 32=green.
    expect(at(0.1)).toMatch(/\x1b\[(?:\d+;)?32m/)
    expect(at(0.7)).toMatch(/\x1b\[(?:\d+;)?33m/)
    expect(at(0.9)).toMatch(/\x1b\[(?:\d+;)?31m/)
  })

  it("hides 'overage' by default", () => {
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    expect(
      stripAnsi(renderQuotaFooter(windows, NO_TOKENS, { overage: { active: false } })),
    ).not.toContain("overage")
  })

  it("surfaces 'overage off' only when showOverage: true and overage is inactive", () => {
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    const out = stripAnsi(
      renderQuotaFooter(windows, NO_TOKENS, {
        showOverage: true,
        overage: { active: false },
      }),
    )
    expect(out).toContain("overage")
    expect(out).toContain("off")
  })

  it("hides overage even with showOverage: true when overage is active", () => {
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    expect(
      stripAnsi(
        renderQuotaFooter(windows, NO_TOKENS, {
          showOverage: true,
          overage: { active: true },
        }),
      ),
    ).not.toContain("overage")
  })

  it("color-grades the quota bar (green <60, yellow 60-84, red >=85)", () => {
    const at = (util: number) =>
      renderQuotaFooter([{ id: "5h", utilization: util }], NO_TOKENS, {
        showSession: false,
      }) ?? ""
    // SGR 31=red, 33=yellow, 32=green.
    expect(at(0.1)).toMatch(/\x1b\[(?:\d+;)?32m/)
    expect(at(0.7)).toMatch(/\x1b\[(?:\d+;)?33m/)
    expect(at(0.9)).toMatch(/\x1b\[(?:\d+;)?31m/)
  })

  it("wide layout: full segments, max separator, full bars", () => {
    const now = 1_700_000_000_000
    const windows: QuotaWindow[] = [
      { id: "5h", utilization: 0.21, resetAtMs: now + 90 * 60_000 },
      { id: "7d", utilization: 0.08, resetAtMs: now + 6 * 24 * 3600 * 1000 },
    ]
    const wide = stripAnsi(
      renderQuotaFooter(windows, SOME_TOKENS, {
        cols: 200,
        now: () => now,
        contextWindow: 200_000,
      }),
    )
    // Wide: everything visible at maximum comfort.
    expect(wide).not.toContain("✦")
    expect(wide).not.toContain("/") // no slash anywhere
    expect(wide).toContain("200k") // size label (LEFT slot)
    expect(wide).toContain("47.5k") // used count (trailing)
    expect(wide).toContain("24%") // session bar percent
    expect(wide).toContain("7d")
    expect(wide).toContain("1h30m")
    // No trailing `ctx` word.
    expect(wide).not.toMatch(/ ctx\b/)
    // Sep=4 (max comfort): the gap between any two segments is 4 cells.
    expect(wide).toMatch(/21% 1h30m {4}7d/)
    // Bars are at max width (8 cells of glyphs).
    const barRun = wide.match(/[█▏▎▍▌▋▊▉]+[░]+|[░]{8}/g)
    expect(barRun).not.toBeNull()
    for (const b of barRun!) expect(b.length).toBeGreaterThanOrEqual(7) // 7 or 8 (1/8th-block ramp may eat one)
  })

  it("compression: separator tightens 4 → 3 → 2 before any drop", () => {
    // Three widths chosen so each triggers exactly one separator step.
    // No effort / sid / overage to keep the math focused on sep alone.
    // Segment costs at bar=8: 5h=15, 7d=14, 200k+47.5k=23.
    const windows: QuotaWindow[] = [
      { id: "5h", utilization: 0.21 },
      { id: "7d", utilization: 0.08 },
    ]
    // sep=4 step cost = 15+4+14+4+23 = 60 cells.
    const sep4 = stripAnsi(
      renderQuotaFooter(windows, SOME_TOKENS, { cols: 200, contextWindow: 200_000 }),
    )
    expect(sep4).toMatch(/21% {4}7d/) // 4-space gap
    // cols=59 forces sep=3 (step cost = 58).
    const sep3 = stripAnsi(
      renderQuotaFooter(windows, SOME_TOKENS, { cols: 59, contextWindow: 200_000 }),
    )
    expect(sep3).toMatch(/21% {3}7d/) // 3-space gap
    // cols=57 forces sep=2 (step cost = 56). Rule 1 floor.
    const sep2 = stripAnsi(
      renderQuotaFooter(windows, SOME_TOKENS, { cols: 57, contextWindow: 200_000 }),
    )
    expect(sep2).toMatch(/21% {2}7d/) // 2-space gap (Rule 1 floor)
  })

  it("compression: bars shrink 8 → 4 cells under pressure (Rule 2.1.1)", () => {
    const windows: QuotaWindow[] = [
      { id: "5h", utilization: 0.5 },
      { id: "7d", utilization: 0.5 },
    ]
    // Bar=4 step cost (sep=2, all tail dropped, session bar still on):
    // empirically 45 cells (`5h ██░░ 50%  7d ██░░ 50%  200k █░░░ 24% 47.5k`).
    // Bar at 50% with 4 cells: eighths=round(50*4*8/100)=16, so 2 full + 0 part + 2 empty = "██░░".
    const tight = stripAnsi(
      renderQuotaFooter(windows, SOME_TOKENS, { cols: 45, contextWindow: 200_000 }),
    )
    expect(tight).toMatch(/5h ██░░ 50%/)
    expect(tight).toMatch(/7d ██░░ 50%/)
    // Session bar shrinks proportionally (same barCells). 24% × 4 cells
    // = 8 eighths = exactly 1 full cell → "█░░░".
    expect(tight).toMatch(/200k █░░░ 24%/)
  })

  it("drops 7d window only after all compressions are exhausted", () => {
    const windows: QuotaWindow[] = [
      { id: "5h", utilization: 0.21 },
      { id: "7d", utilization: 0.08 },
    ]
    // Below the leanest compressed multi-window form, only 5h remains.
    const veryTight = stripAnsi(
      renderQuotaFooter(windows, SOME_TOKENS, { cols: 20, contextWindow: 200_000 }),
    )
    expect(veryTight).toContain("5h")
    expect(veryTight).not.toContain("7d")
    expect(veryTight).not.toContain("47.5k")
  })

  it("drops the session bar but keeps the trailing count at medium widths", () => {
    const now = 1_700_000_000_000
    const windows: QuotaWindow[] = [
      { id: "5h", utilization: 0.21 },
      { id: "7d", utilization: 0.08 },
    ]
    // cols below the leanest "with-session-bar" candidate but above the
    // "without-session-bar" one. With sep=2 + bar=4 the with-bar form
    // is ~45 cells; the bar-dropped form is ~33 cells.
    const mid = stripAnsi(
      renderQuotaFooter(windows, SOME_TOKENS, {
        cols: 40,
        now: () => now,
        contextWindow: 200_000,
      }),
    )
    expect(mid.length).toBeLessThanOrEqual(40 + 1)
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
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    const sess: SessionTokens = { ...NO_TOKENS, contextSize: 1_000, turns: 1 }
    const out = stripAnsi(renderQuotaFooter(windows, sess))
    expect(out).toContain("1k")
    expect(out).not.toContain("1.0k")
  })

  it("fmtTokens uses M suffix at >=1M", () => {
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    const sess: SessionTokens = { ...NO_TOKENS, contextSize: 2_500_000, turns: 1 }
    const out = stripAnsi(renderQuotaFooter(windows, sess, { contextWindow: 1_000_000 }))
    expect(out).toContain("2.5M")
  })

  it("omits reset clause when reset is in the past", () => {
    const now = 1_700_000_000_000
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1, resetAtMs: now - 60_000 }]
    const out = stripAnsi(
      renderQuotaFooter(windows, NO_TOKENS, { now: () => now, showSession: false }),
    )
    // A2: no countdown clause — `<name> <bar> <pct>` with nothing trailing.
    expect(out).toMatch(/5h [█▏▎▍▌▋▊▉░]{8} 10%$/)
  })

  describe("effort segment", () => {
    it("appends `effort <level>` as a trailing segment when opts.effort is set", () => {
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out = stripAnsi(
        renderQuotaFooter(windows, NO_TOKENS, {
          contextWindow: 200_000,
          effort: "medium",
        }),
      )
      // 4-space group separator before `effort`, label leads, value
      // trails. The whole line ends with the level (no meta after).
      expect(out).toMatch(/ {4}effort medium$/)
    })

    it("forwards arbitrary effort strings verbatim (pass-through, no validation)", () => {
      // Mirrors src/effort-resolution.ts no-validate philosophy: any
      // forward-compatible level the server starts accepting should
      // appear in the footer without a client release.
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out = stripAnsi(renderQuotaFooter(windows, NO_TOKENS, { effort: "ultra" }))
      expect(out).toMatch(/effort ultra$/)
    })

    it("omits the effort segment entirely when opts.effort is undefined (haiku case)", () => {
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out = stripAnsi(renderQuotaFooter(windows, NO_TOKENS))
      expect(out).not.toContain("effort")
    })

    it("omits the effort segment when opts.effort is an empty string", () => {
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out = stripAnsi(renderQuotaFooter(windows, NO_TOKENS, { effort: "" }))
      expect(out).not.toContain("effort")
    })

    it("renders the label faintWhite and the value bold", () => {
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out = renderQuotaFooter(windows, NO_TOKENS, { effort: "high" }) ?? ""
      // Label sits on the same visual tier as 5h/7d (faintWhite = dim+white-fg).
      expect(out).toContain("\x1b[2;37meffort\x1b[22;39m")
      // Value pops at bold weight — parallel to the bold trailing
      // session count, signalling "this is the live wire setting".
      expect(out).toContain("\x1b[1mhigh\x1b[22m")
    })

    it("renders <tag>:<level> (bold tag, faint level) when modelLabel is set, replacing the word", () => {
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out =
        renderQuotaFooter(windows, NO_TOKENS, { effort: "max", modelLabel: "anth-4.8" }) ?? ""
      // The compact form drops the literal "effort" word for the tag.
      expect(stripAnsi(out)).toContain("anth-4.8:max")
      expect(stripAnsi(out)).not.toContain("effort")
      expect(out).toContain("\x1b[1manth-4.8\x1b[22m") // bold/bright tag
      expect(out).toContain("\x1b[2m:max\x1b[22m") // faint ":level"
    })

    it("does NOT colour-grade the effort value (no green/yellow/red)", () => {
      // Severity palette belongs to the quota bars. Carrying it onto
      // effort would read "high effort == bad", which is wrong.
      const out =
        renderQuotaFooter([], NO_TOKENS, {
          // no quota windows → no severity SGRs from bars
          showSession: false,
          effort: "max",
        }) ?? ""
      // No 31/32/33 SGRs anywhere in the effort-only render.
      expect(out).not.toMatch(/\x1b\[(?:\d+;)?3[123]m/)
    })

    it("returns the segment even when there are no quota windows AND no session", () => {
      // Effort alone is enough signal to render — the renderer should
      // not collapse to null just because the quota and session pieces
      // would have been empty.
      const out = stripAnsi(
        renderQuotaFooter([], NO_TOKENS, {
          showSession: false,
          effort: "low",
        }),
      )
      expect(out).toBe("effort low".replace(/^/, "")) // exact shape, no leading separator
    })

    it("appears AFTER the session block (effort is the trailing-most segment)", () => {
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out = stripAnsi(
        renderQuotaFooter(windows, SOME_TOKENS, {
          contextWindow: 200_000,
          effort: "medium",
        }),
      )
      // `47.5k` is the unambiguous session marker; `effort` must come
      // after it in the joined string.
      expect(out.indexOf("47.5k")).toBeLessThan(out.indexOf("effort"))
    })

    it("compresses effort `full → value → short` before dropping it (Rule 2.1.2)", () => {
      // The label drops first (`effort medium` → `medium`), then the
      // value shortens (`medium` → `med`), and only as a last resort
      // does the segment go away entirely. Three widths to walk each
      // step.
      const windows: QuotaWindow[] = [
        { id: "5h", utilization: 0.21 },
        { id: "7d", utilization: 0.08 },
      ]
      const opts = { contextWindow: 200_000, effort: "medium" } as const
      // Wide: full form `effort medium`.
      const full = stripAnsi(renderQuotaFooter(windows, SOME_TOKENS, { ...opts, cols: 200 }))
      expect(full).toContain("effort medium")
      // cols=64: forces effortFmt:"value" (`effort medium` → `medium`,
      // saves 7 cells). Step 4 cost = 71-7 = 64.
      const value = stripAnsi(renderQuotaFooter(windows, SOME_TOKENS, { ...opts, cols: 64 }))
      expect(value).not.toContain("effort medium")
      expect(value).toMatch(/ medium$/)
      // cols=62: forces effortFmt:"short" (`medium` → `med`, saves
      // another 3 cells). Step 6 cost = 64-3 = 61.
      const short = stripAnsi(renderQuotaFooter(windows, SOME_TOKENS, { ...opts, cols: 62 }))
      expect(short).not.toMatch(/ medium$/)
      expect(short).toMatch(/ med$/)
    })

    it("drops effort BEFORE dropping the session bar in the degradation ladder", () => {
      // Effort is static-per-session; the session count grows in real
      // time. When width gets tight, the live-growing piece earns its
      // cells over the static one — but only AFTER the full
      // compression ladder has been walked (Rule 2.1.x).
      const windows: QuotaWindow[] = [
        { id: "5h", utilization: 0.21 },
        { id: "7d", utilization: 0.08 },
      ]
      // Compressed step "no effort, with session bar" fits ≈44 cells;
      // the step before it ("effort=short, with session bar") is ≈49.
      const out = stripAnsi(
        renderQuotaFooter(windows, SOME_TOKENS, {
          cols: 47,
          contextWindow: 200_000,
          effort: "medium",
        }),
      )
      // Effort got dropped first (after exhausting `full→value→short`)…
      expect(out).not.toContain("effort")
      expect(out).not.toContain("medium")
      expect(out).not.toMatch(/ med$/)
      // …but the session bar (200k label + percent) survived.
      expect(out).toContain("200k")
      expect(out).toContain("24%")
    })
  })

  describe("sid (session-id anchor) segment", () => {
    it("appends the sid as the ABSOLUTE-trailing segment", () => {
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out = stripAnsi(
        renderQuotaFooter(windows, NO_TOKENS, {
          contextWindow: 200_000,
          effort: "medium",
          sid: "b1d82846",
        }),
      )
      // Line ends with the bare 8-hex sid — no trailing whitespace,
      // no label, no separator.
      expect(out).toMatch(/ {4}b1d82846$/)
      // Effort segment still precedes it.
      expect(out.indexOf("effort medium")).toBeLessThan(out.indexOf("b1d82846"))
    })

    it("renders the sid verbatim (caller pre-shortens, renderer does not slice)", () => {
      // Renderer takes whatever the caller passes and renders it as-is.
      // The handler is responsible for the 8-hex prefix; renderer is
      // just a sink. This keeps the contract simple for tests and
      // future callers that may want different truncations.
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out = stripAnsi(renderQuotaFooter(windows, NO_TOKENS, { sid: "b1d82846-8ee4" }))
      expect(out).toMatch(/ {4}b1d82846-8ee4$/)
    })

    it("omits the sid segment when opts.sid is undefined", () => {
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out = stripAnsi(renderQuotaFooter(windows, NO_TOKENS, { effort: "medium" }))
      // Line ends with the effort segment, no trailing hex blob.
      expect(out).toMatch(/effort medium$/)
    })

    it("omits the sid segment when opts.sid is an empty string", () => {
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out = stripAnsi(renderQuotaFooter(windows, NO_TOKENS, { sid: "" }))
      // No trailing 4-space-then-hex pattern.
      expect(out).not.toMatch(/ {4}[0-9a-f]{6,}$/)
    })

    it("renders the sid dim (static reference, not a live reading)", () => {
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out = renderQuotaFooter(windows, NO_TOKENS, { sid: "b1d82846" }) ?? ""
      // c.dim() is SGR 2 / 22; the value sits inside a plain dim wrap
      // (no white-fg modifier — that's the faintWhite label tier).
      expect(out).toContain("\x1b[2mb1d82846\x1b[22m")
    })

    it("returns the segment even when there are no other parts (sid alone)", () => {
      // If somehow only sid is set and everything else is absent, the
      // line is just the sid. Mirrors the effort-alone test above.
      const out = stripAnsi(
        renderQuotaFooter([], NO_TOKENS, {
          showSession: false,
          sid: "b1d82846",
        }),
      )
      expect(out).toBe("b1d82846")
    })

    it("appears AFTER the effort segment when both are present", () => {
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      const out = stripAnsi(
        renderQuotaFooter(windows, NO_TOKENS, {
          effort: "medium",
          sid: "b1d82846",
        }),
      )
      expect(out.indexOf("effort")).toBeLessThan(out.indexOf("b1d82846"))
    })

    it("drops sid BEFORE dropping effort in the degradation ladder", () => {
      // Forensics anchor is the second-loosest priority on the tail
      // end (after the opt-in overage). Effort, which reflects the
      // live wire config, sticks around longer (in some compressed
      // form — `medium` then `med` — before being dropped itself).
      const windows: QuotaWindow[] = [
        { id: "5h", utilization: 0.21 },
        { id: "7d", utilization: 0.08 },
      ]
      // cols chosen so the ladder lands on
      // {sep:2, effortFmt:"value", withSid:false}. The previous step
      // (sid still on) is ~72 cells; this step is ~62 cells.
      const out = stripAnsi(
        renderQuotaFooter(windows, SOME_TOKENS, {
          cols: 65,
          contextWindow: 200_000,
          effort: "medium",
          sid: "b1d82846",
        }),
      )
      // Sid dropped, effort survived (in compressed form).
      expect(out).not.toContain("b1d82846")
      expect(out).toContain("medium")
    })

    it("drops sid AFTER dropping the opt-in overage segment", () => {
      // When both overage and sid would be present, overage drops
      // first (it's opt-in noise; sid is always-on forensics value).
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
      // cols chosen so the ladder picks
      // {sep:2, effortFmt:"full", withOverage:false} — overage gone,
      // sid + full effort label still present. The sep=2-with-overage
      // step costs ~77 cells; the no-overage step is ~64.
      const out = stripAnsi(
        renderQuotaFooter(windows, SOME_TOKENS, {
          cols: 70,
          contextWindow: 200_000,
          showOverage: true,
          overage: { active: false },
          effort: "medium",
          sid: "b1d82846",
        }),
      )
      expect(out).not.toContain("overage")
      expect(out).toContain("b1d82846")
      expect(out).toContain("effort medium")
    })
  })

  describe("Rule 3: single-line invariant", () => {
    it("never overflows cols in `truncate` mode (default) even at comically narrow widths", () => {
      // Every width from 1 cell up to the leanest fitting candidate
      // must produce a string whose displayed width is <= cols. The
      // truncation safety net (with dim `…`) handles the tail.
      const windows: QuotaWindow[] = [
        { id: "5h", utilization: 0.21 },
        { id: "7d", utilization: 0.08 },
      ]
      // Pull stripAnsi via the same path the renderer uses internally —
      // duplicating the helper here avoids module re-exports.
      const stripAnsiHere = (s: string | null) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "")
      for (let cols = 1; cols <= 60; cols++) {
        const out = stripAnsiHere(
          renderQuotaFooter(windows, SOME_TOKENS, {
            cols,
            contextWindow: 200_000,
            effort: "medium",
            sid: "b1d82846",
          }),
        )
        // Hard invariant: NEVER exceed cols. The whole renderer exists
        // so the live area can paint one row without wrapping the
        // prompt up.
        expect(out.length).toBeLessThanOrEqual(cols)
      }
    })

    it("appends a dim `…` ellipsis when the leanest candidate would still overflow", () => {
      // Force the safety net to fire: cols smaller than even the
      // leanest single-window candidate (5h alone at bar=4 ≈ 11 cells).
      const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.21 }]
      const out =
        renderQuotaFooter(windows, NO_TOKENS, {
          cols: 6,
          showSession: false,
        }) ?? ""
      // Dim `…` (SGR 2 / `\x1b[2m` open, `\x1b[22m` close) marks
      // the truncation. The text content is clipped to cols-1 = 5
      // cells.
      expect(out).toContain("\x1b[2m…\x1b[22m")
      const stripped = out.replace(/\x1b\[[0-9;]*m/g, "")
      expect(stripped.length).toBeLessThanOrEqual(6)
    })

    it("`wrap` mode skips the cols guard and emits the richest form", () => {
      // Opt-out path: caller wants overflow over clipping. Renderer
      // returns the full baseRich form regardless of cols. Terminal
      // natural-wraps the excess; live area grows.
      const windows: QuotaWindow[] = [
        { id: "5h", utilization: 0.21 },
        { id: "7d", utilization: 0.08 },
      ]
      const stripped = (
        renderQuotaFooter(windows, SOME_TOKENS, {
          cols: 30,
          contextWindow: 200_000,
          effort: "medium",
          sid: "b1d82846",
          overflow: "wrap",
        }) ?? ""
      ).replace(/\x1b\[[0-9;]*m/g, "")
      // Way wider than 30 cells — every full segment is present, full
      // separators, full bars.
      expect(stripped.length).toBeGreaterThan(30)
      expect(stripped).toContain("effort medium")
      expect(stripped).toContain("b1d82846")
      expect(stripped).toMatch(/21% {4}7d/) // sep=4 (max)
      // No truncation ellipsis (the safety net doesn't fire in wrap mode).
      expect(stripped).not.toContain("…")
    })
  })

  it("respects showSession: false (suppresses the block even with traffic)", () => {
    const windows: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]
    const out = stripAnsi(renderQuotaFooter(windows, SOME_TOKENS, { showSession: false }))
    expect(out).not.toContain("✦")
    // The live count `47.5k` is the unambiguous session marker. Its
    // absence confirms the block was suppressed. (The `·` label alone
    // wouldn't be a reliable absence-check — it could appear anywhere.)
    expect(out).not.toContain("47.5k")
  })
})

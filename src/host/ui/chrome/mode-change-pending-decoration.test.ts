/**
 * Unit tests for the pending-mode-change live-area decoration
 * (`buildPendingModeChangeDecoration`).
 *
 * Byte-exact assertions on the rendered SGR output. Mirrors the
 * discipline used for `mode-change-chip.test.ts` so unintended
 * color/glyph regressions fail loudly.
 */

import { describe, expect, test } from "bun:test"

import { buildPendingModeChangeDecoration } from "./mode-change-pending-decoration.ts"

const labelMap: Record<string, string> = { ask: "ASK", plan: "PLAN" }
const fgMap: Record<string, string | null> = {
  ask: "\x1b[34m",
  plan: "\x1b[38;5;208m",
}
const resolveLabel = (id: string | null): string => (id == null ? "default" : (labelMap[id] ?? id))
const resolveFgOpen = (id: string | null): string | null =>
  id == null ? null : (fgMap[id] ?? null)

describe("buildPendingModeChangeDecoration", () => {
  test("returns null when nothing is pending", () => {
    expect(buildPendingModeChangeDecoration(null, resolveLabel, resolveFgOpen)).toBeNull()
  })

  test("default → ASK renders the full widget with violet glyph, dim category, dim 'default', bold blue ASK, dim hint", () => {
    const out = buildPendingModeChangeDecoration(
      { fromId: null, toId: "ask" },
      resolveLabel,
      resolveFgOpen,
    )
    expect(out).toBe(
      "  " +
        // violet ⏳ glyph
        "\x1b[38;2;180;140;255m⏳\x1b[39m" +
        " " +
        // dim "mode" category
        "\x1b[2mmode\x1b[22m" +
        "   " +
        // from = "default", no accent → dim
        "\x1b[2mdefault\x1b[22m" +
        " " +
        "\x1b[2m→\x1b[22m" +
        " " +
        // to = "ASK", blue accent, bold
        "\x1b[1m\x1b[34mASK\x1b[0m" +
        "   " +
        "\x1b[2mpending\x1b[22m" +
        " " +
        "\x1b[2m·\x1b[22m" +
        " " +
        "\x1b[2m⌥M to apply now\x1b[22m",
    )
  })

  test("ASK → default uses bold faintWhite for the default target; source keeps its accent", () => {
    const out = buildPendingModeChangeDecoration(
      { fromId: "ask", toId: null },
      resolveLabel,
      resolveFgOpen,
    )
    expect(out).not.toBeNull()
    // Source ASK: accent color, non-bold.
    expect(out).toContain("\x1b[34mASK\x1b[39m")
    // Target default: bold faint-white fallback.
    expect(out).toContain("\x1b[1;37mdefault\x1b[0m")
    // Hint is always present.
    expect(out).toContain("⌥M to apply now")
  })

  test("ASK → PLAN: both accents painted (source non-bold, target bold)", () => {
    const out = buildPendingModeChangeDecoration(
      { fromId: "ask", toId: "plan" },
      resolveLabel,
      resolveFgOpen,
    )
    expect(out).toContain("\x1b[34mASK\x1b[39m")
    expect(out).toContain("\x1b[1m\x1b[38;5;208mPLAN\x1b[0m")
  })

  test("emits no trailing newline (caller decides line termination)", () => {
    const out = buildPendingModeChangeDecoration(
      { fromId: null, toId: "ask" },
      resolveLabel,
      resolveFgOpen,
    )
    expect(out?.endsWith("\n")).toBe(false)
  })

  test("unknown mode id falls through to the resolver fallback labels", () => {
    const out = buildPendingModeChangeDecoration(
      { fromId: null, toId: "unknown-mode-id" },
      resolveLabel,
      () => null, // no accent for anything
    )
    expect(out).toContain("unknown-mode-id")
    // No accent → bold faint-white fallback for the target.
    expect(out).toContain("\x1b[1;37munknown-mode-id\x1b[0m")
  })
})

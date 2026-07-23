/**
 * Unit tests for the mode-change chip + pending-decoration pure builders.
 *
 * Byte-exact assertions on the ANSI output so unintended color/glyph
 * regressions fail the suite loudly. Same discipline as
 * `queue-decoration.test.ts`.
 */

import { describe, expect, test } from "bun:test"

import { ModeManager } from "../../../modes/modes.ts"
import type { ManifestMode } from "../../../plugins/types.ts"

import {
  buildModeChangeChip,
  buildPendingModeChangeChip,
  eventToChipInput,
  formatModeTimestamp,
  labelFor,
} from "./mode-change-chip.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASK_MODE: ManifestMode = {
  id: "ask",
  label: "ASK",
  style: {
    label: { fg: "blue", bold: true },
    arrow: { fg: "blue", bold: true },
    status: { fg: "blue" },
  },
}

const PLAN_MODE: ManifestMode = {
  id: "plan",
  label: "PLAN",
  color: "orange",
}

const NOSTYLE_MODE: ManifestMode = {
  id: "raw",
  label: "RAW",
  // No style, no color — exercises the no-color fallback path.
}

/** Fixed Date: 2026-05-22 17:52 local (whatever the runner's TZ is). */
const FIXED_AT = new Date(2026, 4, 22, 17, 52, 30) // months are 0-indexed

// ---------------------------------------------------------------------------
// formatModeTimestamp
// ---------------------------------------------------------------------------

describe("formatModeTimestamp", () => {
  test("formats YYYY-MM-DD HH:MM with zero-padded fields", () => {
    expect(formatModeTimestamp(FIXED_AT)).toBe("2026-05-22 17:52")
  })

  test("zero-pads single-digit month/day/hour/minute", () => {
    expect(formatModeTimestamp(new Date(2026, 0, 3, 4, 5))).toBe("2026-01-03 04:05")
  })

  test("drops seconds (we only render to minute precision)", () => {
    const sameMinute = new Date(2026, 4, 22, 17, 52, 0)
    const laterSecond = new Date(2026, 4, 22, 17, 52, 59)
    expect(formatModeTimestamp(sameMinute)).toBe(formatModeTimestamp(laterSecond))
  })
})

// ---------------------------------------------------------------------------
// labelFor
// ---------------------------------------------------------------------------

describe("labelFor", () => {
  test("returns 'default' for null", () => {
    expect(labelFor(null)).toBe("default")
  })

  test("returns the mode label as-is when present", () => {
    expect(labelFor(ASK_MODE)).toBe("ASK")
  })

  test("falls back to uppercased id when label is missing", () => {
    expect(labelFor({ id: "lockdown" })).toBe("LOCKDOWN")
  })

  test("empty-string label falls back to uppercased id", () => {
    expect(labelFor({ id: "ask", label: "" })).toBe("ASK")
  })
})

// ---------------------------------------------------------------------------
// buildModeChangeChip
// ---------------------------------------------------------------------------

describe("buildModeChangeChip", () => {
  test("default → ASK: dim · chip-lead, dim 'mode' category, brand-primary 'default', dim arrow, bold blue ASK, faint-white timestamp", () => {
    const brand = "\x1b[38;5;199m" // palette brand/pink — same as prompt ❯
    const out = buildModeChangeChip({
      fromLabel: "default",
      toLabel: "ASK",
      fromFgOpen: brand,
      toFgOpen: "\x1b[34m",
      at: FIXED_AT,
    })
    // Layout: `  · mode   default → ASK   2026-05-22 17:52`
    expect(out).toBe(
      "  " +
        "\x1b[2m·\x1b[22m" +
        " " +
        "\x1b[2mmode\x1b[22m" +
        "   " +
        // from = "default", brand primary (prompt arrow pigment)
        `${brand}default\x1b[39m` +
        " " +
        "\x1b[2m→\x1b[22m" +
        " " +
        // to = "ASK", blue accent, bold
        "\x1b[1m\x1b[34mASK\x1b[0m" +
        "   " +
        "\x1b[2;37m2026-05-22 17:52\x1b[22;39m",
    )
  })

  test("no target color (raw mode) falls back to bold faintWhite label, lead stays dim", () => {
    const out = buildModeChangeChip({
      fromLabel: "default",
      toLabel: "RAW",
      fromFgOpen: null,
      toFgOpen: null,
      at: FIXED_AT,
    })
    expect(out).toContain("\x1b[2m·\x1b[22m")
    expect(out).toContain("\x1b[2mmode\x1b[22m")
    expect(out).toContain("\x1b[1;37mRAW\x1b[0m")
    // No sparkle anywhere — design dropped it.
    expect(out).not.toContain("✦")
    // No "from X" tail anymore.
    expect(out).not.toContain("from")
  })

  test("non-default 'from' (PLAN → ASK) paints source in its accent, non-bold", () => {
    const out = buildModeChangeChip({
      fromLabel: "PLAN",
      toLabel: "ASK",
      fromFgOpen: "\x1b[38;5;208m", // orange
      toFgOpen: "\x1b[34m", // blue
      at: FIXED_AT,
    })
    // Source: accent color, NO bold.
    expect(out).toContain("\x1b[38;5;208mPLAN\x1b[39m")
    // Target: accent color, WITH bold.
    expect(out).toContain("\x1b[1m\x1b[34mASK\x1b[0m")
  })

  test("ASK → default: source non-bold accent, target bold brand primary", () => {
    const brand = "\x1b[38;5;199m"
    const out = buildModeChangeChip({
      fromLabel: "ASK",
      toLabel: "default",
      fromFgOpen: "\x1b[34m",
      toFgOpen: brand,
      at: FIXED_AT,
    })
    // Source: accent color, non-bold.
    expect(out).toContain("\x1b[34mASK\x1b[39m")
    // Target: bold brand primary (same pigment as prompt ❯).
    expect(out).toContain(`\x1b[1m${brand}default\x1b[0m`)
  })

  test("emits no trailing newline (caller appends \\n live, \\n\\n in replay)", () => {
    const out = buildModeChangeChip({
      fromLabel: "default",
      toLabel: "ASK",
      fromFgOpen: null,
      toFgOpen: "\x1b[34m",
      at: FIXED_AT,
    })
    expect(out.endsWith("\n")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildPendingModeChangeChip
// ---------------------------------------------------------------------------

describe("buildPendingModeChangeChip", () => {
  const brand = "\x1b[38;5;199m"
  const labelMap: Record<string, string> = { ask: "ASK", plan: "PLAN" }
  const fgMap: Record<string, string | null> = {
    ask: "\x1b[34m",
    plan: "\x1b[38;5;208m",
  }
  const resolveLabel = (id: string | null): string =>
    id == null ? "default" : (labelMap[id] ?? id)
  // Mirrors ModeManager.resolvedForId: null id → brand primary.
  const resolveFgOpen = (id: string | null): string | null =>
    id == null ? brand : (fgMap[id] ?? null)
  const at = new Date("2026-05-22T17:52:00")

  test("returns null when pending is null (net-zero between submits)", () => {
    expect(buildPendingModeChangeChip(null, resolveLabel, resolveFgOpen, at)).toBeNull()
  })

  test("renders bytes identical to buildModeChangeChip for the same data", () => {
    const got = buildPendingModeChangeChip(
      { fromId: null, toId: "ask" },
      resolveLabel,
      resolveFgOpen,
      at,
    )
    const want = buildModeChangeChip({
      fromLabel: "default",
      toLabel: "ASK",
      fromFgOpen: brand,
      toFgOpen: "\x1b[34m",
      at,
    })
    expect(got).toBe(want)
  })

  test("ASK → default uses bold brand primary for the default target, source keeps its accent", () => {
    const got = buildPendingModeChangeChip(
      { fromId: "ask", toId: null },
      resolveLabel,
      resolveFgOpen,
      at,
    )
    expect(got).toContain("\x1b[34mASK\x1b[39m") // source non-bold accent
    expect(got).toContain(`\x1b[1m${brand}default\x1b[0m`) // target bold brand
  })
})

// ---------------------------------------------------------------------------
// Integration: eventToChipInput + ModeManager
// ---------------------------------------------------------------------------

describe("eventToChipInput", () => {
  test("threads from/to labels and target color out of a ModeManager event", () => {
    const m = new ModeManager([ASK_MODE, PLAN_MODE], null, undefined, () => FIXED_AT)
    m.setMode("ask")
    const event = m.lastTransition()!
    expect(event).not.toBeNull()
    expect(event.at).toEqual(FIXED_AT)

    const input = eventToChipInput(
      event,
      (mode) => m.resolvedForId(mode?.id ?? null)?.label.fgOpen ?? null,
    )
    expect(input.fromLabel).toBe("default")
    expect(input.toLabel).toBe("ASK")
    // No-mode/"default" resolves to brand primary (prompt arrow pigment).
    expect(input.fromFgOpen).toBe("\x1b[38;5;199m")
    // ASK_MODE's style requests `fg: "blue"` which maps to legacy ANSI 34.
    expect(input.toFgOpen).toBe("\x1b[34m")
    expect(input.at).toEqual(FIXED_AT)
  })

  test("ASK → PLAN transition carries both labels", () => {
    const m = new ModeManager([ASK_MODE, PLAN_MODE], "ask", undefined, () => FIXED_AT)
    m.setMode("plan")
    const event = m.lastTransition()!
    const input = eventToChipInput(
      event,
      (mode) => m.resolvedForId(mode?.id ?? null)?.label.fgOpen ?? null,
    )
    expect(input.fromLabel).toBe("ASK")
    expect(input.toLabel).toBe("PLAN")
  })

  test("modes without style get a null fg", () => {
    const m = new ModeManager([NOSTYLE_MODE], null, undefined, () => FIXED_AT)
    m.setMode("raw")
    const event = m.lastTransition()!
    const input = eventToChipInput(
      event,
      (mode) => m.resolvedForId(mode?.id ?? null)?.label.fgOpen ?? null,
    )
    expect(input.toFgOpen).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ModeManager.peekPendingAttachment
// ---------------------------------------------------------------------------

describe("ModeManager.peekPendingAttachment", () => {
  test("returns null at startup", () => {
    const m = new ModeManager([ASK_MODE])
    expect(m.peekPendingAttachment()).toBeNull()
  })

  test("returns { from: null, to: 'ask' } after entering ASK", () => {
    const m = new ModeManager([ASK_MODE])
    m.setMode("ask")
    expect(m.peekPendingAttachment()).toEqual({ fromId: null, toId: "ask" })
  })

  test("peek is non-mutating: subsequent consume still produces the attachment", () => {
    const m = new ModeManager([ASK_MODE])
    m.setMode("ask")
    expect(m.peekPendingAttachment()).not.toBeNull()
    expect(m.peekPendingAttachment()).not.toBeNull()
    // Consume only after multiple peeks.
    expect(m.consumePendingAttachment()).not.toBeNull()
    // Now peek goes null and a follow-up consume too.
    expect(m.peekPendingAttachment()).toBeNull()
    expect(m.consumePendingAttachment()).toBeNull()
  })

  test("collapses to null when active matches last-advertised after a net-zero toggle", () => {
    const m = new ModeManager([ASK_MODE])
    m.setMode("ask")
    m.consumePendingAttachment() // lastAdvertised = "ask"
    m.setMode(null)
    m.setMode("ask")
    expect(m.peekPendingAttachment()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ModeManager.lastTransition timestamp
// ---------------------------------------------------------------------------

describe("ModeManager.lastTransition", () => {
  test("returns null before any toggle", () => {
    const m = new ModeManager([ASK_MODE])
    expect(m.lastTransition()).toBeNull()
  })

  test("records timestamp from injected clock", () => {
    const m = new ModeManager([ASK_MODE], null, undefined, () => FIXED_AT)
    m.setMode("ask")
    expect(m.lastTransition()?.at).toEqual(FIXED_AT)
  })

  test("subscribers receive the event as a second arg", () => {
    const m = new ModeManager([ASK_MODE, PLAN_MODE], null, undefined, () => FIXED_AT)
    const events: {
      active: string | null
      event: { fromLabel: string; toLabel: string } | null
    }[] = []
    m.subscribe((active, event) => {
      events.push({
        active: active?.id ?? null,
        event: event ? { fromLabel: labelFor(event.from), toLabel: labelFor(event.to) } : null,
      })
    })
    m.setMode("ask")
    m.setMode("plan")
    expect(events).toEqual([
      { active: "ask", event: { fromLabel: "default", toLabel: "ASK" } },
      { active: "plan", event: { fromLabel: "ASK", toLabel: "PLAN" } },
    ])
  })
})

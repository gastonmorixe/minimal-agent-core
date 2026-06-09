/**
 * Tests for the colored, width-aware live-area footer row. TUI-only, so it
 * carries ANSI — asserted against the shared PALETTE so the colors stay
 * consistent with the rest of the live area. `cols` is passed explicitly so
 * the progressive-disclosure tiers are deterministic.
 */

import { describe, expect, it } from "bun:test"

import { PALETTE } from "../../../src/palette.ts"
import { displayWidth } from "../../../src/term-width.ts"

import { formatStatusRow } from "./footer.ts"
import type { CronEntry } from "./store.ts"

const NOW = 1_700_000_000_000
const WIDE = 100
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

function mk(over: Partial<CronEntry> = {}): CronEntry {
  return {
    id: "abcd1234",
    cron: "*/5 * * * *",
    prompt: "check the deploy",
    recurs: true,
    pace: "dynamic",
    nextAtMs: NOW + 5 * 60_000,
    createdAt: 0,
    ...over,
  }
}

describe("formatStatusRow (footer)", () => {
  it("returns null when there are no tasks", () => {
    expect(formatStatusRow([], NOW, WIDE)).toBeNull()
  })

  it("uses the ⧗ hourglass glyph, never the old ⏰/◷", () => {
    const row = formatStatusRow([mk()], NOW, WIDE)!
    expect(row).toContain("⧗")
    expect(row).not.toContain("⏰")
    expect(row).not.toContain("◷")
  })

  it("gold when the next fire is far, lime when imminent", () => {
    expect(formatStatusRow([mk({ nextAtMs: NOW + 30 * 60_000 })], NOW, WIDE)!).toContain(
      PALETTE.gold,
    )
    const soon = formatStatusRow([mk({ nextAtMs: NOW + 10_000 })], NOW, WIDE)!
    expect(soon).toContain(PALETTE.lime)
    expect(soon).not.toContain(PALETTE.gold)
  })

  it("shows the soonest task's id + countdown when wide", () => {
    const row = plain(formatStatusRow([mk({ id: "v3muss8a" })], NOW, WIDE)!)
    expect(row).toContain("v3muss8a")
    expect(row).toContain("next in 5m")
  })

  it("lists multiple task ids, soonest first, when wide", () => {
    const row = plain(
      formatStatusRow(
        [
          mk({ id: "slow0001", nextAtMs: NOW + 20 * 60_000 }),
          mk({ id: "soon0002", nextAtMs: NOW + 2 * 60_000 }),
        ],
        NOW,
        WIDE,
      )!,
    )
    expect(row).toContain("soon0002") // soonest leads
    expect(row).toContain("slow0001") // other id listed
    expect(row).toContain("in 2m") // soonest's countdown
    // soonest appears before the other id
    expect(row.indexOf("soon0002")).toBeLessThan(row.indexOf("slow0001"))
  })

  it("appends a +K overflow marker when ids don't all fit", () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      mk({ id: `task000${i}`, nextAtMs: NOW + (i + 1) * 60_000 }),
    )
    // Width fits the lead (`⧗ task0000 next in 1m`, 21 cells) + the `+K`
    // marker, but not another full id — so the overflow marker must show.
    const row = plain(formatStatusRow(entries, NOW, 28)!)
    expect(row).toMatch(/\+\d/) // a +K marker
  })

  it("degrades to a bare count when too narrow for ids", () => {
    const row = plain(formatStatusRow([mk(), mk({ id: "x" })], NOW, 12)!)
    expect(row).toContain("2 tasks")
    expect(row).not.toContain("abcd1234")
  })

  it("never renders wider than the column budget", () => {
    const entries = Array.from({ length: 5 }, (_, i) => mk({ id: `id00000${i}` }))
    for (const cols of [80, 40, 24, 12, 6, 3]) {
      const row = formatStatusRow(entries, NOW, cols)
      if (row !== null) expect(displayWidth(row)).toBeLessThanOrEqual(cols)
    }
  })

  it("always closes its color (full reset) so the footer can't bleed", () => {
    expect(formatStatusRow([mk()], NOW, WIDE)!).toContain("\x1b[0m")
  })
})

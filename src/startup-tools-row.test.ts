import { describe, expect, test } from "bun:test"

import { c } from "./agent.ts"
import { formatStartupToolsRow, wrapStartupToolsRows } from "./startup-tools-row.ts"
import { displayWidth, stripAnsi } from "./term-width.ts"

describe("formatStartupToolsRow", () => {
  test("empty input returns null", () => {
    expect(formatStartupToolsRow([])).toBe(null)
  })

  test("single tool, no icon → bare name", () => {
    expect(formatStartupToolsRow([{ name: "MemoryTool" }])).toBe("MemoryTool")
  })

  test("single tool, icon + known color → colored icon, plain name", () => {
    const out = formatStartupToolsRow([{ name: "ShowDiff", icon: "±", color: "lime" }])
    expect(out).toBe(`${c.lime("±")} ShowDiff`)
  })

  test("single tool, icon + no color → faintWhite icon", () => {
    const out = formatStartupToolsRow([{ name: "Foo", icon: "*" }])
    expect(out).toBe(`${c.faintWhite("*")} Foo`)
  })

  test("single tool, icon + unknown color → faintWhite icon (defensive fallback)", () => {
    const out = formatStartupToolsRow([
      { name: "Foo", icon: "*", color: "definitely-not-a-real-color" },
    ])
    expect(out).toBe(`${c.faintWhite("*")} Foo`)
  })

  test("multiple tools join with dim mid-dot", () => {
    const out = formatStartupToolsRow([
      { name: "ShowDiff", icon: "±", color: "lime" },
      { name: "MemoryTool" },
      { name: "WebSearch" },
    ])
    const sep = c.dim(" · ")
    expect(out).toBe(`${c.lime("±")} ShowDiff${sep}MemoryTool${sep}WebSearch`)
  })

  test("color is applied only to the icon, not the name", () => {
    const out = formatStartupToolsRow([{ name: "ShowDiff", icon: "±", color: "lime" }])
    // The name appears unwrapped in the output (no SGR foreground close
    // immediately after it). The simplest check: the substring " ShowDiff"
    // exists with no ANSI bytes inside it.
    expect(out).toContain(" ShowDiff")
    expect(out).not.toContain(`ShowDiff\x1b[`)
  })

  test("name with no icon doesn't synthesize a leading space", () => {
    // Regression: an earlier draft prepended a space for icon-less items
    // to keep visual alignment, which made every row look one cell wider
    // than its content. The current contract is "no icon → no space".
    expect(formatStartupToolsRow([{ name: "Foo" }])).toBe("Foo")
    expect(formatStartupToolsRow([{ name: "Foo" }, { name: "Bar" }])).toBe(`Foo${c.dim(" · ")}Bar`)
  })
})

describe("wrapStartupToolsRows", () => {
  test("empty input returns no lines", () => {
    expect(wrapStartupToolsRows([], 80)).toEqual([])
  })

  test("everything on one line when it fits", () => {
    const lines = wrapStartupToolsRows([{ name: "A" }, { name: "B" }, { name: "C" }], 80)
    expect(lines).toHaveLength(1)
    expect(stripAnsi(lines[0]!)).toBe("A · B · C")
  })

  test("wraps to multiple lines, never splitting a chunk, each ≤ maxWidth", () => {
    const tools = [
      { name: "Alpha" },
      { name: "Bravo" },
      { name: "Charlie" },
      { name: "Delta" },
      { name: "Echo" },
    ]
    // Width 14 fits ~"Alpha · Bravo" (13) but not a third chunk.
    const lines = wrapStartupToolsRows(tools, 14)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(14)
    }
    // Re-joining the visible text recovers the full inventory in order
    // (nothing dropped, nothing truncated).
    const rejoined = lines.map((l) => stripAnsi(l)).join(" · ")
    expect(rejoined).toBe("Alpha · Bravo · Charlie · Delta · Echo")
  })

  test("a single chunk wider than maxWidth gets its own line (no truncation)", () => {
    const lines = wrapStartupToolsRows([{ name: "SupercalifragilisticTool" }], 8)
    expect(lines).toHaveLength(1)
    expect(stripAnsi(lines[0]!)).toBe("SupercalifragilisticTool")
  })

  test("emoji-presentation icon width is accounted for when wrapping", () => {
    // ⏰ is 2 cells. "⏰ CronCreate" = 13 cells; with a budget of 13 it
    // must sit alone on its line (adding " · " + anything overflows).
    const lines = wrapStartupToolsRows(
      [
        { name: "CronCreate", icon: "⏰", color: "gold" },
        { name: "CronList", icon: "⏰", color: "gold" },
      ],
      13,
    )
    expect(lines).toHaveLength(2)
    expect(displayWidth(lines[0]!)).toBeLessThanOrEqual(13)
    expect(stripAnsi(lines[0]!)).toBe("⏰ CronCreate")
  })

  test("non-positive maxWidth degrades to a single joined line", () => {
    const lines = wrapStartupToolsRows([{ name: "A" }, { name: "B" }], 0)
    expect(lines).toHaveLength(1)
    expect(stripAnsi(lines[0]!)).toBe("A · B")
  })
})

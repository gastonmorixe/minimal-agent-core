import { describe, expect, test } from "bun:test"

import { c } from "./agent.ts"
import { formatStartupToolsRow } from "./startup-tools-row.ts"

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

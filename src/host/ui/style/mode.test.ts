import { describe, expect, it } from "bun:test"

import { displayWidth } from "../../../terminal/term-width.ts"

import { clampLabel, MAX_LABEL_WIDTH } from "./mode.ts"

describe("clampLabel (B-072: display-width truncation)", () => {
  it("passes short ASCII labels through unchanged", () => {
    expect(clampLabel("ASK")).toBe("ASK")
    expect(clampLabel("PLAN")).toBe("PLAN")
    // Exactly at the budget: no ellipsis.
    expect(clampLabel("EXACTLY8")).toBe("EXACTLY8")
    expect(displayWidth(clampLabel("EXACTLY8"))).toBe(MAX_LABEL_WIDTH)
  })

  it("truncates an over-long ASCII label to body + ellipsis", () => {
    const out = clampLabel("A VERY LONG LABEL")
    expect(out).toBe("A VER...")
    expect(displayWidth(out)).toBe(MAX_LABEL_WIDTH)
  })

  it("never overflows on wide CJK (old .length math let it through)", () => {
    // Five full-width glyphs = 10 display cells. The old code measured this as
    // `.length === 5 <= 8` and returned it untouched, overflowing the prompt.
    const out = clampLabel("日本語モード")
    expect(displayWidth(out)).toBeLessThanOrEqual(MAX_LABEL_WIDTH)
    expect(out.endsWith("...")).toBe(true)
  })

  it("never splits a surrogate pair (astral codepoints)", () => {
    // Astral (>U+FFFF) chars are surrogate pairs in UTF-16. The old
    // `.slice(0, n)` could cut between the high and low surrogate, yielding a
    // lone surrogate (mojibake). The width-aware cut keeps codepoints whole.
    const out = clampLabel("𝔘𝔫𝔦𝔠𝔬𝔡𝔢𝔵𝔶𝔷")
    // No unpaired surrogate survives a round-trip through a well-formed string.
    expect(out).toBe(out.toWellFormed())
    expect(displayWidth(out)).toBeLessThanOrEqual(MAX_LABEL_WIDTH)
  })

  it("handles the empty label", () => {
    expect(clampLabel("")).toBe("")
  })
})

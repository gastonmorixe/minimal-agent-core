/**
 * Tests for `ui/theme/types.ts` — focus on the constructors with runtime
 * validation (the brand-only `unsafe*` constructors are tested only
 * structurally elsewhere).
 */

import { describe, expect, it } from "bun:test"

import {
  asToken,
  Err,
  HUES,
  type Hue,
  Ok,
  parseHex,
  STEPS,
  type Step,
  THEME_VARIANTS,
  type ThemeVariant,
} from "./types.ts"

describe("parseHex", () => {
  it("accepts 6-char lowercase hex", () => {
    expect(parseHex("#abcdef")).toBe("#abcdef" as ReturnType<typeof parseHex>)
  })

  it("accepts 6-char uppercase hex (normalises to lowercase)", () => {
    expect(parseHex("#ABCDEF")).toBe("#abcdef" as ReturnType<typeof parseHex>)
  })

  it("rejects 3-char shorthand", () => {
    expect(parseHex("#abc")).toBeNull()
  })

  it("rejects missing hash", () => {
    expect(parseHex("abcdef")).toBeNull()
  })

  it("rejects 8-char (RGBA) form — terminal SGRs don't carry alpha", () => {
    expect(parseHex("#abcdef12")).toBeNull()
  })

  it("rejects non-hex characters", () => {
    expect(parseHex("#abcdez")).toBeNull()
  })

  it("rejects empty string", () => {
    expect(parseHex("")).toBeNull()
  })
})

describe("asToken", () => {
  it("brands without runtime validation (validation happens at resolution)", () => {
    // The whole point of asToken is intent-marking; it accepts anything.
    expect(asToken("definitely-not-a-real-token")).toBe(
      "definitely-not-a-real-token" as ReturnType<typeof asToken>,
    )
  })
})

describe("Result helpers", () => {
  it("Ok wraps a value with ok:true", () => {
    const r = Ok(42)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(42)
  })

  it("Err wraps an error with ok:false", () => {
    const r = Err({ kind: "unknown_token" as const, token: "nope" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("unknown_token")
  })

  it("Ok and Err narrow exhaustively via switch", () => {
    const r: ReturnType<typeof Ok<number>> | ReturnType<typeof Err<string>> = Ok(1)
    // exhaustive — TS compile would fail if we missed a branch
    const out = r.ok ? r.value + 1 : r.error.length
    expect(out).toBe(2)
  })
})

describe("HUES catalog", () => {
  it("contains exactly 13 unique hues", () => {
    expect(HUES.length).toBe(13)
    expect(new Set(HUES).size).toBe(13)
  })

  it("includes the well-known names", () => {
    const expected: Hue[] = [
      "red",
      "orange",
      "yellow",
      "lime",
      "green",
      "teal",
      "cyan",
      "blue",
      "indigo",
      "violet",
      "magenta",
      "pink",
      "gray",
    ]
    for (const h of expected) expect(HUES).toContain(h)
  })
})

describe("STEPS catalog", () => {
  it("contains exactly 5 ordered steps", () => {
    expect(STEPS.length).toBe(5)
    const expected: Step[] = ["darker", "dark", "base", "bright", "brighter"]
    expect([...STEPS]).toEqual(expected)
  })

  it("is symmetric around base (darker↔darker, etc.)", () => {
    // base sits at the center; two steps lighter and two darker.
    const baseIdx = STEPS.indexOf("base")
    expect(baseIdx).toBe(2)
    expect(STEPS[baseIdx - 1]).toBe("dark")
    expect(STEPS[baseIdx + 1]).toBe("bright")
  })
})

describe("THEME_VARIANTS catalog", () => {
  it("contains the three known variants", () => {
    const expected: ThemeVariant[] = ["dark", "light", "high-contrast"]
    expect([...THEME_VARIANTS]).toEqual(expected)
  })
})

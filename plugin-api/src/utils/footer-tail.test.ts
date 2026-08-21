import { describe, expect, it, beforeEach } from "bun:test"

import {
  applyFooterTails,
  clearFooterTails,
  getFooterTails,
  setFooterTail,
} from "./footer-tail.ts"

const widthOf = (s: string) => s.length

describe("footer-tail registry", () => {
  beforeEach(() => clearFooterTails())

  it("returns empty string when no tails published", () => {
    expect(getFooterTails()).toBe("")
  })

  it("joins multiple keys with a two-space gap", () => {
    setFooterTail("a", "one")
    setFooterTail("b", "two")
    expect(getFooterTails()).toBe("one  two")
  })

  it("keys are independent — no clobber between plugins", () => {
    setFooterTail("tps", "42/tps")
    setFooterTail("other", "badge")
    expect(getFooterTails()).toContain("42/tps")
    expect(getFooterTails()).toContain("badge")
  })

  it("same key overwrites (last writer wins)", () => {
    setFooterTail("tps", "10/tps")
    setFooterTail("tps", "20/tps")
    expect(getFooterTails()).toBe("20/tps")
  })

  it("empty string clears one key without touching others", () => {
    setFooterTail("tps", "42/tps")
    setFooterTail("other", "badge")
    setFooterTail("tps", "")
    expect(getFooterTails()).toBe("badge")
  })
})

describe("applyFooterTails padding rule", () => {
  it("pads so line + pad + tails ends at cols", () => {
    // line=10, tails=6, cols=30 → pad=14
    const out = applyFooterTails("0123456789", "tail!!", 30, widthOf)
    expect(out).toBe("0123456789" + " ".repeat(14) + "tail!!")
    expect(out.length).toBe(30)
  })

  it("clamps pad to a minimum of 2 cells", () => {
    // line=10, tails=6, cols=17 → pad would be 1 → clamped to 2
    const out = applyFooterTails("0123456789", "tail!!", 17, widthOf)
    expect(out).toBe("0123456789  tail!!")
  })

  it("falls back to inline gap when pad goes negative", () => {
    const out = applyFooterTails("longer-line-here", "tail!!", 10, widthOf)
    expect(out).toBe("longer-line-here  tail!!")
  })

  it("falls back to inline gap when cols is unknown", () => {
    const out = applyFooterTails("line", "tail", undefined, widthOf)
    expect(out).toBe("line  tail")
  })

  it("measures display width via the injected widthOf (ANSI-blind)", () => {
    // ANSI escapes contribute 0 cells under a real widthOf; simulate with
    // a widthOf that ignores the escape sequence.
    const ansiWidthOf = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length
    const styled = "\x1b[2m42/tps\x1b[22m"
    const out = applyFooterTails("line", styled, 20, ansiWidthOf)
    // line=4, visible tails=6 → pad=10
    expect(out).toBe("line" + " ".repeat(10) + styled)
  })
})

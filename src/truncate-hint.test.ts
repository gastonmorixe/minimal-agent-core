import { describe, expect, test } from "bun:test"
import { clampWithHint, truncHint } from "./truncate-hint.ts"

describe("truncHint", () => {
  test("returns empty string when nothing was elided", () => {
    expect(truncHint(0)).toBe("")
    expect(truncHint(-5)).toBe("")
  })

  test("formats characters by default", () => {
    expect(truncHint(45)).toBe("...(+45ch)")
  })

  test("supports bytes and lines as alternative units", () => {
    expect(truncHint(312, "B")).toBe("...(+312B)")
    expect(truncHint(4, "L")).toBe("...(+4L)")
  })
})

describe("clampWithHint", () => {
  test("returns string unchanged when within budget", () => {
    expect(clampWithHint("hello", 10)).toBe("hello")
    expect(clampWithHint("hello", 5)).toBe("hello")
  })

  test("clamps and appends elided-count hint", () => {
    expect(clampWithHint("abcdefghij", 4)).toBe("abcd...(+6ch)")
  })

  test("honors custom unit", () => {
    expect(clampWithHint("abcdefghij", 4, "B")).toBe("abcd...(+6B)")
  })
})

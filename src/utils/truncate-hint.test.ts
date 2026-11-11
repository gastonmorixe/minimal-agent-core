import { describe, expect, test } from "bun:test"

import { clampWithHint } from "./truncate-hint.ts"

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

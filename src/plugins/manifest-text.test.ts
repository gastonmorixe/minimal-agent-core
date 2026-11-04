/**
 * Unit tests for the shared plain-text check (`manifest-text.ts`, R-3).
 *
 * @module plugins/manifest-text.test
 */

import { describe, expect, it } from "bun:test"

import { hasUnsafeTextChar, isUnsafeTextCode, plainTextError } from "./manifest-text.ts"

describe("isUnsafeTextCode", () => {
  it("rejects C0, DEL, C1, and the bidi controls", () => {
    const banned = [
      0x00, 0x09, 0x0a, 0x1b, 0x1f, 0x7f, 0x80, 0x9b, 0x9f, 0x061c, 0x200e, 0x200f, 0x202a, 0x202b,
      0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
    ]
    for (const c of banned) expect(isUnsafeTextCode(c)).toBe(true)
  })

  it("accepts printable characters next to the banned ranges", () => {
    for (const c of [0x20, 0x7e, 0xa0, 0x061b, 0x200d, 0x2029, 0x206a]) {
      expect(isUnsafeTextCode(c)).toBe(false)
    }
  })
})

describe("plainTextError", () => {
  it("returns undefined for valid text and an error for each bad case", () => {
    expect(plainTextError("ok", 10)).toBeUndefined()
    expect(plainTextError("", 10, false)).toBeUndefined()
    expect(plainTextError(1, 10)).toBe("must be a string")
    expect(plainTextError("", 10)).toBe("must not be empty")
    expect(plainTextError("x".repeat(11), 10)).toBe("longer than 10 characters")
    expect(plainTextError(`a${String.fromCodePoint(0x202e)}b`, 10)).toMatch(/control or bidi/)
  })

  it("hasUnsafeTextChar scans the whole string", () => {
    expect(hasUnsafeTextChar("plain text")).toBe(false)
    expect(hasUnsafeTextChar(`end${String.fromCodePoint(0x7f)}`)).toBe(true)
  })
})

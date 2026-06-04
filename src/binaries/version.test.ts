import { describe, expect, it } from "bun:test"

import { compareVersions, isNewer, parseVersion } from "./version.ts"

describe("parseVersion", () => {
  it("parses dotted numeric", () => {
    expect(parseVersion("0.1.6")?.fields).toEqual([0, 1, 6])
  })
  it("strips a leading v", () => {
    expect(parseVersion("v1.2.3")?.fields).toEqual([1, 2, 3])
  })
  it("parses a bare epoch integer as one field", () => {
    expect(parseVersion("1733345678")?.fields).toEqual([1733345678])
  })
  it("keeps leading digits of a mixed field", () => {
    expect(parseVersion("1-rc2")?.fields).toEqual([1])
  })
  it("returns null for non-numeric tokens", () => {
    expect(parseVersion("latest")).toBeNull()
    expect(parseVersion("")).toBeNull()
  })
})

describe("compareVersions", () => {
  it("orders dotted versions", () => {
    expect(compareVersions("0.1.6", "0.1.5")).toBeGreaterThan(0)
    expect(compareVersions("0.1.5", "0.1.6")).toBeLessThan(0)
    expect(compareVersions("0.1.6", "0.1.6")).toBe(0)
  })
  it("treats missing trailing fields as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0)
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0)
  })
  it("orders epoch integers", () => {
    expect(compareVersions("1733345679", "1733345678")).toBeGreaterThan(0)
  })
  it("an epoch dwarfs a dotted release (migration order)", () => {
    expect(compareVersions("1733345678", "0.1.6")).toBeGreaterThan(0)
  })
  it("returns NaN when either token is unparseable", () => {
    expect(Number.isNaN(compareVersions("latest", "0.1.6"))).toBe(true)
    expect(Number.isNaN(compareVersions("0.1.6", "nightly"))).toBe(true)
  })
})

describe("isNewer", () => {
  it("true when candidate is strictly newer", () => {
    expect(isNewer("0.1.7", "0.1.6")).toBe(true)
  })
  it("false when equal or older", () => {
    expect(isNewer("0.1.6", "0.1.6")).toBe(false)
    expect(isNewer("0.1.5", "0.1.6")).toBe(false)
  })
  it("false on unparseable input", () => {
    expect(isNewer("latest", "0.1.6")).toBe(false)
  })
})

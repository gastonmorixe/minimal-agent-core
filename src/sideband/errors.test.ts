import { describe, expect, it } from "bun:test"

import {
  SidebandCodecMissingError,
  SidebandError,
  SidebandKindDuplicateError,
  SidebandKindInvalidError,
} from "./errors.ts"

describe("sideband errors", () => {
  it("has empty message and name equal to kind", () => {
    const e = new SidebandKindDuplicateError("k", "a", "b")
    expect(e.message).toBe("")
    expect(e.name).toBe("SidebandKindDuplicateError")
    expect(e.kind).toBe(SidebandKindDuplicateError.kind)
    expect(e).toBeInstanceOf(SidebandError)
    expect(e).toBeInstanceOf(Error)
  })

  it("toJSON gives kind and fields", () => {
    expect(new SidebandKindDuplicateError("k", "a", "b").toJSON()).toEqual({
      kind: "SidebandKindDuplicateError",
      fields: { sidebandKind: "k", ownerA: "a", ownerB: "b" },
    })
    expect(new SidebandKindInvalidError("k", "p", "attr-name").toJSON().fields).toEqual({
      sidebandKind: "k",
      pluginId: "p",
      rule: "attr-name",
    })
    expect(new SidebandCodecMissingError().toJSON()).toEqual({
      kind: "SidebandCodecMissingError",
      fields: {},
    })
  })
})

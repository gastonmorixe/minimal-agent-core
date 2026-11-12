import { describe, expect, it } from "bun:test"

import {
  SidebandCodecDuplicateError,
  SidebandCodecMissingError,
  SidebandKindDuplicateError,
  SidebandKindInvalidError,
  SidebandLegacyAliasDuplicateError,
  SidebandRegistryFrozenError,
} from "./errors.ts"
import { createSidebandRegistry } from "./registry.ts"
import type { SidebandCodec, SidebandKind } from "./types.ts"

function mk(over: Partial<SidebandKind> = {}): SidebandKind {
  return {
    kind: "note",
    owner: "ignored",
    direction: "to-model",
    placement: "turn",
    attrs: {},
    body: "text",
    trust: "harness",
    summary: "s",
    ...over,
  }
}

function rule(kind: SidebandKind): string | undefined {
  try {
    createSidebandRegistry().register(kind, "p")
  } catch (e) {
    return e instanceof SidebandKindInvalidError ? e.rule : "other"
  }
  return undefined
}

const fakeCodec: SidebandCodec = {
  id: "fake",
  render: () => "",
  parse: () => [],
  scanner: () => ({ write() {}, end() {}, onText() {}, onNode() {} }),
  neutralize: (t) => t,
  example: () => "",
}

describe("sideband registry", () => {
  it("sets owner", () => {
    const r = createSidebandRegistry()
    r.register(mk(), "plug-a")
    expect(r.kind("note")?.owner).toBe("plug-a")
    expect(r.kinds().length).toBe(1)
  })

  it("rejects duplicate kind with both owners", () => {
    const r = createSidebandRegistry()
    r.register(mk(), "a")
    try {
      r.register(mk(), "b")
      throw new Error("unreachable")
    } catch (e) {
      expect(e).toBeInstanceOf(SidebandKindDuplicateError)
      const d = e as SidebandKindDuplicateError
      expect([d.sidebandKind, d.ownerA, d.ownerB]).toEqual(["note", "a", "b"])
    }
  })

  it("rejects duplicate legacy alias", () => {
    const r = createSidebandRegistry()
    r.register(mk({ legacy: ["old"] }), "a")
    expect(() => r.register(mk({ kind: "other", legacy: ["old"] }), "b")).toThrow(
      SidebandLegacyAliasDuplicateError,
    )
  })

  it("rejects second codec", () => {
    const r = createSidebandRegistry()
    r.setCodec(() => fakeCodec, "a")
    expect(() => r.setCodec(() => fakeCodec, "b")).toThrow(SidebandCodecDuplicateError)
  })

  it("throws when no codec", () => {
    expect(() => createSidebandRegistry().codec()).toThrow(SidebandCodecMissingError)
  })

  it("builds codec once from the factory", () => {
    const r = createSidebandRegistry()
    r.setCodec(() => fakeCodec, "a")
    expect(r.codec()).toBe(r.codec())
  })

  it("rejects register after freeze", () => {
    const r = createSidebandRegistry()
    r.freeze()
    expect(() => r.register(mk(), "a")).toThrow(SidebandRegistryFrozenError)
  })

  it("rejects each SB-REG-5 rule", () => {
    expect(rule(mk({ kind: "Bad_Name" }))).toBe("kind-name")
    expect(rule(mk({ kind: "a".repeat(65) }))).toBe("kind-name")
    expect(rule(mk({ kind: "xml-thing" }))).toBe("kind-xml-prefix")
    expect(rule(mk({ kind: "XmlThing" }))).toBe("kind-xml-prefix")
    expect(rule(mk({ attrs: { Bad: { type: "string" } } }))).toBe("attr-name")
    expect(rule(mk({ attrs: { e: { type: "enum" } } }))).toBe("enum-values")
    expect(rule(mk({ attrs: { e: { type: "enum", values: ["\u0001"] } } }))).toBe("enum-value-char")
    expect(rule(mk({ direction: "from-model", placement: "inline", body: "raw" }))).toBe(
      "from-model-raw-body",
    )
    expect(rule(mk({ direction: "from-model", placement: "turn", body: "text" }))).toBe(
      "from-model-placement",
    )
    expect(rule(mk())).toBeUndefined()
  })
})

describe("registry hardening", () => {
  it("rejects core and empty owner", () => {
    for (const owner of ["core", ""]) {
      try {
        createSidebandRegistry().register(mk(), owner)
        throw new Error("no throw")
      } catch (e) {
        expect(e).toBeInstanceOf(SidebandKindInvalidError)
        expect((e as SidebandKindInvalidError).rule).toBe("core-owner")
      }
    }
  })
  it("gives the factory a read-only view", () => {
    let seen: Record<string, unknown> = {}
    const r = createSidebandRegistry()
    r.setCodec((view) => {
      seen = view as unknown as Record<string, unknown>
      return fakeCodec
    }, "p")
    r.codec()
    expect(Object.keys(seen).sort()).toEqual(["kind", "kinds"])
    expect(seen.register).toBeUndefined()
    expect(seen.freeze).toBeUndefined()
    expect(seen.setCodec).toBeUndefined()
  })
  it("isolates stored kinds from input and output", () => {
    const r = createSidebandRegistry()
    const input = mk({
      attrs: { a: { type: "string" } },
      legacy: ["old"],
      example: { kind: "note", attrs: { a: "1" } },
    })
    r.register(input, "p")
    input.attrs.b = { type: "int" }
    input.legacy?.push("x")
    const got = r.kind("note") as SidebandKind
    expect(Object.keys(got.attrs)).toEqual(["a"])
    expect(got.legacy).toEqual(["old"])
    expect(() => {
      got.attrs.c = { type: "bool" }
    }).toThrow()
    expect(() => got.legacy?.push("y")).toThrow()
    expect(Object.keys((r.kind("note") as SidebandKind).attrs)).toEqual(["a"])
  })
})

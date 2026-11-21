import { describe, expect, it } from "bun:test"

import type { CoreAnnotationKind } from "../../plugin-api/src/types/tool-outcome.ts"
import { CORE_OWNED_KINDS } from "../sdk/tool-outcome-record.ts"

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

  it("rejects setCodec after freeze; the old codec stays", () => {
    const r = createSidebandRegistry()
    r.setCodec(() => fakeCodec, "a")
    r.freeze()
    const other: SidebandCodec = { ...fakeCodec, id: "other" }
    expect(() => r.setCodec(() => other, "late")).toThrow(SidebandRegistryFrozenError)
    expect(r.codec()).toBe(fakeCodec)
  })

  it("rejects the first setCodec after freeze; no codec is set", () => {
    const r = createSidebandRegistry()
    r.freeze()
    try {
      r.setCodec(() => fakeCodec, "late")
      throw new Error("no throw")
    } catch (e) {
      expect(e).toBeInstanceOf(SidebandRegistryFrozenError)
      expect((e as SidebandRegistryFrozenError).ownerPluginId).toBe("late")
    }
    expect(() => r.codec()).toThrow(SidebandCodecMissingError)
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
  it("any plugin can declare each core annotation kind; the first wins (D1 revised)", () => {
    const coreKinds: Record<CoreAnnotationKind, true> = {
      "mode-active": true,
      policy: true,
      "raw-output": true,
      "output-preview": true,
      "output-truncated": true,
      "output-streak": true,
      diagnostics: true,
    }
    for (const kind of Object.keys(coreKinds)) {
      const r = createSidebandRegistry()
      r.register(mk({ kind }), "first")
      expect(r.kind(kind)?.owner).toBe("first")
      try {
        r.register(mk({ kind }), "second")
        throw new Error("no throw")
      } catch (e) {
        expect(e).toBeInstanceOf(SidebandKindDuplicateError)
        expect((e as SidebandKindDuplicateError).toJSON().fields).toEqual({
          sidebandKind: kind,
          ownerA: "first",
          ownerB: "second",
        })
      }
      expect(r.kind(kind)?.owner).toBe("first")
    }
    expect(CORE_OWNED_KINDS.size).toBe(Object.keys(coreKinds).length)
  })
  it("owner core cannot declare a core annotation kind (core-owner)", () => {
    try {
      createSidebandRegistry().register(mk({ kind: "policy" }), "core")
      throw new Error("no throw")
    } catch (e) {
      expect(e).toBeInstanceOf(SidebandKindInvalidError)
      expect((e as SidebandKindInvalidError).rule).toBe("core-owner")
    }
  })
  it("a normal kind still registers; a kind that only starts like a core kind registers", () => {
    const r = createSidebandRegistry()
    r.register(mk({ kind: "note" }), "evil")
    r.register(mk({ kind: "raw-output-extra" }), "evil")
    r.register(mk({ kind: "my-policy" }), "evil")
    expect(r.kinds().map((k) => k.kind)).toEqual(["note", "raw-output-extra", "my-policy"])
  })
  it("other case forms of a core kind fail the name rule first (no normalization)", () => {
    expect(rule(mk({ kind: "Raw-Output" }))).toBe("kind-name")
    expect(rule(mk({ kind: "POLICY" }))).toBe("kind-name")
    expect(rule(mk({ kind: " policy" }))).toBe("kind-name")
  })
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

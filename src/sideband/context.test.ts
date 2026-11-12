import { describe, expect, it } from "bun:test"

import { createPluginSidebandContext } from "./context.ts"
import { SidebandCodecMissingError, SidebandKindUnknownError } from "./errors.ts"
import { createSidebandRegistry } from "./registry.ts"
import type { SidebandCodec } from "./types.ts"

const codec: SidebandCodec = {
  id: "fake",
  render: (k, m) => `${k.kind}|${m.kind}|${m.body ?? ""}`,
  parse: (t) => [
    { kind: t, attrs: {}, selfClosing: true, form: "v2", span: { start: 0, end: t.length } },
  ],
  scanner: () => ({ write() {}, end() {}, onText() {}, onNode() {} }),
  neutralize: (t) => t,
  example: () => "",
}

describe("plugin sideband context", () => {
  it("throws without codec", () => {
    const ctx = createPluginSidebandContext(createSidebandRegistry())
    expect(() => ctx.render("note", {})).toThrow(SidebandCodecMissingError)
    expect(() => ctx.parse("x")).toThrow(SidebandCodecMissingError)
  })

  it("renders and parses with a fake codec", () => {
    const r = createSidebandRegistry()
    r.register(
      {
        kind: "note",
        owner: "",
        direction: "to-model",
        placement: "turn",
        attrs: {},
        body: "text",
        trust: "harness",
        summary: "s",
      },
      "p",
    )
    r.setCodec(() => codec, "c")
    const ctx = createPluginSidebandContext(r)
    expect(ctx.render("note", { body: "b" })).toBe("note|note|b")
    expect(ctx.parse("abc")[0]?.kind).toBe("abc")
  })

  it("throws on unknown kind", () => {
    const r = createSidebandRegistry()
    r.setCodec(() => codec, "c")
    expect(() => createPluginSidebandContext(r).render("nope", {})).toThrow(
      SidebandKindUnknownError,
    )
  })
})

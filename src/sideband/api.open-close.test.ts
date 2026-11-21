/**
 * `SidebandApi.open` and `close` (step 14, design 50 §5): the same rules as
 * `render`. The stub codec has a wire form that is not XML, so core shows
 * that it only calls the codec.
 */

import { describe, expect, it } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"

import { createSidebandApi, NO_SIDEBAND } from "./api.ts"
import { SidebandKindUnknownError } from "./errors.ts"
import { createSidebandRegistry } from "./registry.ts"
import type { SidebandCodec, SidebandKind } from "./types.ts"

function codec(withParts: boolean): SidebandCodec {
  const c: SidebandCodec = {
    id: "stub",
    render: (k, m) => `[${k.kind}|${m.body ?? ""}]`,
    parse: () => [],
    scanner: () => ({ write() {}, end() {}, onText() {}, onNode() {} }),
    neutralize: (t) => t,
    example: (k) => `[${k.kind}]`,
  }
  if (withParts) {
    c.open = (k, m) =>
      `[${k.kind}${Object.entries(m.attrs ?? {})
        .map(([a, v]) => ` ${a}=${v}`)
        .join("")}|`
    c.close = (k) => `|${k.kind}]`
  }
  return c
}

const KIND: SidebandKind = {
  kind: "note",
  owner: "",
  direction: "to-model",
  placement: "inline",
  attrs: { n: { type: "int" } },
  body: "text",
  trust: "harness",
  summary: "s",
}

function api(c?: SidebandCodec) {
  const events: LogEvent[] = []
  const r = createSidebandRegistry()
  r.register(KIND, "p")
  if (c) r.setCodec(() => c, "c")
  r.freeze()
  const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
  return { sb: createSidebandApi(r, { diagnostics }), events }
}

const dropped = (events: LogEvent[]) =>
  events.filter((e) => e.source === "sideband.render-dropped").length

describe("SidebandApi.open and close", () => {
  it("call the codec parts", () => {
    const { sb } = api(codec(true))
    expect(sb.open("note", { attrs: { n: 2 } })).toBe("[note n=2|")
    expect(sb.open("note")).toBe("[note|")
    expect(sb.close("note")).toBe("|note]")
  })

  it("an unknown kind throws with a codec", () => {
    const { sb } = api(codec(true))
    expect(() => sb.open("nope")).toThrow(SidebandKindUnknownError)
    expect(() => sb.close("nope")).toThrow(SidebandKindUnknownError)
  })

  it("no codec gives an empty string and one drop diagnostic for each kind", () => {
    const { sb, events } = api()
    expect(sb.open("note")).toBe("")
    expect(sb.close("note")).toBe("")
    expect(dropped(events)).toBe(1)
  })

  it("a codec with no open or close gives an empty string and one drop diagnostic", () => {
    const { sb, events } = api(codec(false))
    expect(sb.open("note")).toBe("")
    expect(sb.close("note")).toBe("")
    expect(dropped(events)).toBe(1)
    expect(() => sb.open("nope")).toThrow(SidebandKindUnknownError)
  })

  it("NO_SIDEBAND has them", () => {
    expect(NO_SIDEBAND.open("x")).toBe("")
    expect(NO_SIDEBAND.close("x")).toBe("")
  })
})

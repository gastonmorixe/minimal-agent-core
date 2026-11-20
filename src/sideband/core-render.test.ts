/**
 * Tests of `renderCoreKind`: a codec with no declaration of a core kind
 * gives `""` and one diagnostic, no throw (step 6 review finding 1).
 */

import { describe, expect, it } from "bun:test"

import { wrapHookContext } from "../sdk/hook-context.ts"
import { wrapUpContent } from "../sdk/wrap-up.ts"

import { createSidebandApi, type SidebandApiDiagnostics } from "./api.ts"
import { renderCoreKind, SIDEBAND_CORE_KIND_MISSING } from "./core-render.ts"
import { SidebandKindUnknownError } from "./errors.ts"
import { createSidebandRegistry } from "./registry.ts"
import type { SidebandCodec, SidebandKind } from "./types.ts"

/** A codec with a wire form that is not XML. */
const CODEC: SidebandCodec = {
  id: "stub-braces",
  render: (k, m) => `{{${k.kind}|${m.body ?? ""}}}`,
  parse: () => [],
  scanner: () => ({ write() {}, end() {}, onText() {}, onNode() {} }),
  neutralize: (t) => t,
  example: (k) => `{{${k.kind}|...}}`,
}

const NOTE: SidebandKind = {
  kind: "note",
  owner: "",
  direction: "to-model",
  placement: "tool-result",
  attrs: {},
  body: "text",
  trust: "harness",
  summary: "s",
}

/** A recording diagnostics sink. */
function sink(): SidebandApiDiagnostics & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = []
  return { calls, warn: (source, _m, data) => void calls.push([source, data]) }
}

/** An API with a codec and only the `note` kind (no `policy`, no `wrap-up`). */
function apiWithCodec(diagnostics?: SidebandApiDiagnostics) {
  const r = createSidebandRegistry()
  r.register(NOTE, "p")
  r.setCodec(() => CODEC, "c")
  return createSidebandApi(r, diagnostics ? { diagnostics } : {})
}

describe("renderCoreKind", () => {
  it('codec and no `policy` kind: gives "" and one diagnostic, no throw', () => {
    const d = sink()
    const sb = apiWithCodec(d)
    // The API rule stays: plain `render` throws for an unknown kind.
    expect(() => sb.render("policy", { body: "x" })).toThrow(SidebandKindUnknownError)
    expect(renderCoreKind(sb, "policy", { body: "x" })).toBe("")
    expect(renderCoreKind(sb, "policy", { body: "y" })).toBe("")
    expect(d.calls).toEqual([[SIDEBAND_CORE_KIND_MISSING, { kind: "policy" }]])
  })

  it("one diagnostic for each kind", () => {
    const d = sink()
    const sb = apiWithCodec(d)
    renderCoreKind(sb, "policy")
    renderCoreKind(sb, "wrap-up")
    renderCoreKind(sb, "wrap-up")
    expect(d.calls.map((c) => c[1])).toEqual([{ kind: "policy" }, { kind: "wrap-up" }])
  })

  it("an explicit sink wins over the sink of the API", () => {
    const own = sink()
    const given = sink()
    renderCoreKind(apiWithCodec(own), "policy", {}, given)
    expect(own.calls).toEqual([])
    expect(given.calls).toEqual([[SIDEBAND_CORE_KIND_MISSING, { kind: "policy" }]])
  })

  it('no sink: "" and no throw', () => {
    expect(renderCoreKind(apiWithCodec(), "policy", { body: "x" })).toBe("")
  })

  it("a declared kind renders as `render` does", () => {
    const d = sink()
    const sb = apiWithCodec(d)
    expect(renderCoreKind(sb, "note", { body: "b" })).toBe(sb.render("note", { body: "b" }))
    expect(d.calls).toEqual([])
  })

  it("other errors pass", () => {
    const boom = {
      render: (): string => {
        throw new TypeError("boom")
      },
    }
    expect(() => renderCoreKind(boom, "policy")).toThrow(TypeError)
  })

  it("core emitters do not throw: hook context and wrap-up give nothing", () => {
    const d = sink()
    const sb = apiWithCodec(d)
    expect(wrapHookContext(sb, ["a", "b"])).toBe("")
    expect(wrapUpContent(sb, { text: "stop" } as Parameters<typeof wrapUpContent>[1])).toEqual([])
    expect(d.calls.map((c) => c[1])).toEqual([{ kind: "policy" }, { kind: "wrap-up" }])
  })
})

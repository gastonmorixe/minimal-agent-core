import { describe, expect, test } from "bun:test"

import {
  type CoreErrorJson,
  createErrorRendererRegistry,
  InvariantError,
  isCoreErrorJson,
} from "./index.ts"

function live(): InvariantError {
  try {
    return new InvariantError("a.b", { n: 2 })
  } catch {
    throw new Error("unreachable")
  }
}

const rn = (tag: string, kinds: readonly string[] | "*") => ({
  kinds,
  render: (e: CoreErrorJson) => `${tag}:${e.kind}`,
})

describe("C45 registry", () => {
  test("registered renderer renders, live and JSON alike", () => {
    const reg = createErrorRendererRegistry()
    reg.register(rn("p", ["InvariantError"]), "plug")
    const e = live()
    expect(reg.render(e)).toBe("p:InvariantError")
    expect(reg.render(JSON.parse(JSON.stringify(e)))).toBe(reg.render(e))
  })
  test("unknown kind returns undefined, empty registry too", () => {
    const reg = createErrorRendererRegistry()
    expect(reg.render(live())).toBeUndefined()
    reg.register(rn("p", ["Other"]), "plug")
    expect(reg.render(live())).toBeUndefined()
    expect(reg.render({ kind: "Nope", fields: {} })).toBeUndefined()
  })
  test("host wins over plugin, in any registration order", () => {
    for (const order of [
      ["host", "plug"],
      ["plug", "host"],
    ] as const) {
      const reg = createErrorRendererRegistry()
      for (const o of order) reg.register(rn(o, ["InvariantError"]), o)
      expect(reg.render(live())).toBe("host:InvariantError")
    }
  })
  test("exact kind beats star within one owner, star covers the rest", () => {
    const reg = createErrorRendererRegistry()
    reg.register(rn("star", "*"), "plug")
    reg.register(rn("exact", ["InvariantError"]), "plug")
    expect(reg.render(live())).toBe("exact:InvariantError")
    expect(reg.render({ kind: "Z", fields: {} })).toBe("star:Z")
  })
  test("host star renderer beats plugin exact kind (spec: host wins)", () => {
    const reg = createErrorRendererRegistry()
    reg.register(rn("plug", ["InvariantError"]), "plug")
    reg.register(rn("host", "*"), "host")
    expect(reg.render(live())).toBe("host:InvariantError")
  })
  test("non-error input returns undefined and does not throw", () => {
    const reg = createErrorRendererRegistry()
    reg.register(rn("s", "*"), "host")
    for (const v of [null, "str", 42, { message: "x" }, undefined]) {
      expect(reg.render(v as never)).toBeUndefined()
    }
  })
  test("renderer returning undefined falls through to next candidate", () => {
    const reg = createErrorRendererRegistry()
    reg.register({ kinds: "*", render: () => undefined }, "host")
    reg.register(rn("p", ["InvariantError"]), "plug")
    expect(reg.render(live())).toBe("p:InvariantError")
  })
  test("dispatch uses kind only, not instanceof or constructor.name", () => {
    const reg = createErrorRendererRegistry()
    reg.register(rn("p", ["Fake"]), "plug")
    expect(reg.render({ kind: "Fake", fields: {} })).toBe("p:Fake")
  })
  const envelopes: Record<string, (error: CoreErrorJson) => unknown> = {
    "stream-json result": (error) => ({ type: "result", is_error: true, error }),
    "ACP error.data": (error) => ({ jsonrpc: "2.0", id: 1, error: { code: -32603, data: error } }),
    "web event": (error) => ({ type: "error", error }),
    "sub-agent IPC": (error) => ({ status: "failed", error }),
  }
  for (const [name, wrap] of Object.entries(envelopes)) {
    test(`JSON hop: ${name}`, () => {
      const reg = createErrorRendererRegistry()
      reg.register(rn("p", ["InvariantError"]), "plug")
      const e = live()
      const wire = JSON.parse(JSON.stringify(wrap(e.toJSON()))) as Record<string, unknown>
      const err = (wire.error as { data?: unknown }).data ?? wire.error
      expect(isCoreErrorJson(err)).toBe(true)
      expect(reg.render(err as CoreErrorJson)).toBe(reg.render(e))
    })
  }
})

describe("isCoreErrorJson", () => {
  test("accepts toJSON, rejects plain message", () => {
    expect(isCoreErrorJson(live().toJSON())).toBe(true)
    expect(isCoreErrorJson({ message: "x" })).toBe(false)
    expect(isCoreErrorJson(null)).toBe(false)
    expect(isCoreErrorJson("x")).toBe(false)
    expect(isCoreErrorJson({ kind: 1, fields: {} })).toBe(false)
    expect(isCoreErrorJson({ kind: "X" })).toBe(false)
    expect(isCoreErrorJson({ kind: "X", fields: [] })).toBe(false)
  })
})

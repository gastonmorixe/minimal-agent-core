import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import * as errors from "./index.ts"
import { CoreError } from "./index.ts"

class SampleError extends CoreError {
  static readonly kind = "SampleError"
  declare readonly kind: "SampleError"
  readonly path: string
  constructor(path: string, options?: { cause?: unknown }) {
    super(options)
    this.path = path
  }
}

function subclasses(): (typeof CoreError & { kind: string })[] {
  const out: (typeof CoreError & { kind: string })[] = []
  for (const v of Object.values(errors)) {
    if (typeof v === "function" && v !== CoreError && v.prototype instanceof CoreError) {
      out.push(v as never)
    }
  }
  return out
}

describe("C39 CoreError", () => {
  test("message empty, kind === name === class name, own kind", () => {
    const e = new SampleError("/a")
    expect(e.message).toBe("")
    expect(e.kind).toBe("SampleError")
    expect(e.name).toBe("SampleError")
    expect(Object.hasOwn(e, "kind")).toBe(true)
    expect(Object.hasOwn(e, "name")).toBe(true)
    expect(e instanceof Error).toBe(true)
  })
  test("first stack line equals kind", () => {
    const e = new SampleError("/a")
    expect(e.stack?.split("\n")[0]).toBe("SampleError")
  })
  test("kind unique across module subclasses and equals class name", () => {
    const subs = subclasses()
    expect(subs.length).toBeGreaterThan(0)
    const kinds = subs.map((c) => c.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    for (const c of subs) expect(c.kind).toBe(c.name)
  })
  test("toJSON round trip equals and keeps fields", () => {
    const e = new SampleError("/a")
    const j = e.toJSON()
    expect(j).toEqual({ kind: "SampleError", fields: { path: "/a" } })
    expect(JSON.parse(JSON.stringify(e))).toEqual(j)
  })
  describe("toJSON normalizes fields", () => {
    class Bag extends CoreError {
      static readonly kind = "Bag"
      declare readonly kind: "Bag"
      constructor(readonly v: unknown) {
        super()
      }
    }
    const fieldsOf = (v: unknown): unknown => new Bag(v).toJSON().fields.v
    test("undefined dropped and JSON round trip equal", () => {
      class Two extends CoreError {
        static readonly kind = "Two"
        declare readonly kind: "Two"
        constructor(
          readonly a: unknown,
          readonly b: unknown,
        ) {
          super()
        }
      }
      const e = new Two(1, undefined)
      expect("b" in e.toJSON().fields).toBe(false)
      expect(JSON.parse(JSON.stringify(e))).toEqual(e.toJSON())
      expect(new Bag({ x: undefined, y: 1 }).toJSON().fields.v).toEqual({ y: 1 })
    })
    test("Date becomes ISO string", () => {
      const d = new Date(0)
      expect(fieldsOf(d)).toBe(d.toISOString())
    })
    test("nested CoreError field and array", () => {
      const inner = new SampleError("/in")
      expect(fieldsOf(inner)).toEqual(inner.toJSON())
      expect(fieldsOf([1, inner, undefined, new Date(0)])).toEqual([
        1,
        inner.toJSON(),
        null,
        new Date(0).toISOString(),
      ])
    })
    test("bigint, function, symbol get a typed marker", () => {
      expect(fieldsOf(1n)).toEqual({ kind: "UnserializableValue", type: "bigint" })
      expect(fieldsOf(() => 1)).toEqual({ kind: "UnserializableValue", type: "function" })
      expect(fieldsOf(Symbol("s"))).toEqual({ kind: "UnserializableValue", type: "symbol" })
      expect(() => JSON.stringify(new Bag(1n))).not.toThrow()
    })
    test("circular value gets a marker and does not throw", () => {
      const o: Record<string, unknown> = { a: 1 }
      o.self = o
      expect(fieldsOf(o)).toEqual({ a: 1, self: { kind: "UnserializableValue", type: "object" } })
      expect(() => JSON.stringify(new Bag(o))).not.toThrow()
    })
  })
  test("foreign cause carries no message", () => {
    const foreign = Object.assign(new Error("boom secret"), { code: "ENOENT", errno: -2 })
    const e = new SampleError("/a", { cause: foreign })
    const j = e.toJSON()
    expect(j.cause).toEqual({ kind: "ForeignError", code: "ENOENT", errno: -2 })
    expect(JSON.stringify(j)).not.toContain("boom secret")
    expect(new SampleError("/a", { cause: "str secret" }).toJSON().cause).toEqual({
      kind: "ForeignError",
    })
  })
  test("CoreError cause becomes its toJSON", () => {
    const inner = new SampleError("/in")
    const j = new SampleError("/out", { cause: inner }).toJSON()
    expect(j.cause).toEqual(inner.toJSON())
  })
  test("minified build keeps kind", async () => {
    const dir = join(import.meta.dir, "..", "..", "tmp", "errors-minify")
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    try {
      const entry = join(dir, "entry.ts")
      const base = join(import.meta.dir, "core-error.ts")
      writeFileSync(
        entry,
        `import { CoreError } from ${JSON.stringify(base)}
class MinifyProbeError extends CoreError {
  static readonly kind = "MinifyProbeError"
  declare readonly kind: "MinifyProbeError"
}
const e = new MinifyProbeError()
console.log(e.kind + "|" + e.name)
`,
      )
      const out = join(dir, "out.js")
      const b = Bun.spawnSync(["bun", "build", "--minify", entry, "--outfile", out])
      expect(b.exitCode).toBe(0)
      const r = Bun.spawnSync(["bun", out])
      expect(r.stdout.toString().trim()).toBe("MinifyProbeError|MinifyProbeError")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("C40 invariant", () => {
  test("throws InvariantError", () => {
    let caught: unknown
    try {
      errors.invariant("x.y", { a: 1 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(errors.InvariantError)
    const e = caught as errors.InvariantError
    expect(e.message).toBe("")
    expect(e.kind).toBe("InvariantError")
    expect(e.invariant).toBe("x.y")
    expect(e.data.a).toBe(1)
    expect(e.toJSON().fields).toEqual({ invariant: "x.y", data: { a: 1 } })
  })
  test("data defaults to empty record", () => {
    try {
      errors.invariant("x")
    } catch (e) {
      expect((e as errors.InvariantError).data).toEqual({})
    }
  })
})

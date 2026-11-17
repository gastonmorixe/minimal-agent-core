/**
 * Each hostile-plugin fixture behaves as its name says.
 *
 * @module test-utils/hostile-plugin.test
 */

import { describe, expect, it } from "bun:test"

import {
  HOSTILE_PROXY_TRAPS,
  HostileFixtureError,
  jsonProtoKey,
  neverSettlingPromise,
  revokedProxy,
  thenable,
  throwingGetter,
  throwingProxy,
  throwingProxyFunction,
  throwingThenable,
} from "./hostile-plugin.ts"

/** One operation for each object trap. */
const OBJECT_TRAP_OPS: Record<string, (p: Record<string, unknown>) => unknown> = {
  get: (p) => p.x,
  has: (p) => "x" in p,
  ownKeys: (p) => Object.keys(p),
  getPrototypeOf: (p) => Object.getPrototypeOf(p),
  setPrototypeOf: (p) => Object.setPrototypeOf(p, null),
  getOwnPropertyDescriptor: (p) => Object.getOwnPropertyDescriptor(p, "x"),
  set: (p) => {
    p.x = 1
  },
  defineProperty: (p) => Object.defineProperty(p, "x", { value: 1 }),
  deleteProperty: (p) => delete p.x,
  isExtensible: (p) => Object.isExtensible(p),
  preventExtensions: (p) => Object.preventExtensions(p),
}

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

describe("hostile-plugin fixtures", () => {
  it("throwingGetter: keys work, the read throws", () => {
    const v = throwingGetter()
    expect(Object.keys(v)).toEqual(["text"])
    expect(() => v.text).toThrow(HostileFixtureError)
    expect(() => ({ ...v })).toThrow(HostileFixtureError)
    expect(() => throwingGetter("data").data).toThrow("get data")
  })

  it("throwingProxy: each object trap throws, typeof does not", () => {
    const p = throwingProxy()
    expect(typeof p).toBe("object")
    for (const [trap, op] of Object.entries(OBJECT_TRAP_OPS)) {
      const error = thrown(() => op(p))
      expect(error, trap).toBeInstanceOf(HostileFixtureError)
      expect((error as HostileFixtureError).trap).toBe(trap)
    }
    expect(Object.keys(OBJECT_TRAP_OPS).sort()).toEqual(
      HOSTILE_PROXY_TRAPS.filter((t) => t !== "apply" && t !== "construct").sort(),
    )
  })

  it("revokedProxy: each operation throws TypeError, typeof does not", () => {
    const p = revokedProxy()
    expect(typeof p).toBe("object")
    for (const [trap, op] of Object.entries(OBJECT_TRAP_OPS)) {
      expect(
        thrown(() => op(p)),
        trap,
      ).toBeInstanceOf(TypeError)
    }
    expect(() => JSON.stringify(p)).toThrow(TypeError)
  })

  it("throwingProxyFunction: typeof is function, call and new throw", () => {
    const f = throwingProxyFunction()
    expect(typeof f).toBe("function")
    expect((thrown(() => f()) as HostileFixtureError).trap).toBe("apply")
    const Ctor = f as unknown as new () => unknown
    expect((thrown(() => new Ctor()) as HostileFixtureError).trap).toBe("construct")
    expect((thrown(() => f.name) as HostileFixtureError).trap).toBe("get")
  })

  it("jsonProtoKey: own __proto__ key, normal prototype", () => {
    const v = jsonProtoKey()
    expect(Object.hasOwn(v, "__proto__")).toBe(true)
    expect(Object.keys(v)).toEqual(["text", "__proto__"])
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype)
    expect((v as { polluted?: unknown }).polluted).toBeUndefined()
    const naive: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) naive[k] = val
    expect(Object.hasOwn(naive, "__proto__")).toBe(false)
    expect((naive as { polluted?: unknown }).polluted).toBe(true)
  })

  it("thenable: await gives the value", async () => {
    const t = thenable(42)
    expect(t instanceof Promise).toBe(false)
    expect(typeof t.then).toBe("function")
    expect(await t).toBe(42)
  })

  it("throwingThenable: await rejects with the then error", async () => {
    const error = await Promise.resolve(throwingThenable()).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(HostileFixtureError)
    expect((error as HostileFixtureError).trap).toBe("then")
  })

  it("neverSettlingPromise: does not settle", async () => {
    const marker = Symbol("pending")
    const winner = await Promise.race([
      neverSettlingPromise(),
      new Promise((resolve) => queueMicrotask(() => resolve(marker))),
    ])
    expect(winner).toBe(marker)
  })

  it("each factory gives a fresh value on each call", () => {
    expect(throwingGetter()).not.toBe(throwingGetter())
    expect(throwingProxy()).not.toBe(throwingProxy())
    expect(revokedProxy()).not.toBe(revokedProxy())
    expect(throwingProxyFunction()).not.toBe(throwingProxyFunction())
    expect(jsonProtoKey()).not.toBe(jsonProtoKey())
    expect(thenable(1)).not.toBe(thenable(1))
    expect(throwingThenable()).not.toBe(throwingThenable())
    expect(neverSettlingPromise()).not.toBe(neverSettlingPromise())
  })
})

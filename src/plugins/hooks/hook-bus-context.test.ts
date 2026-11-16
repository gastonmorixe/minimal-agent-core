/**
 * Tests for `additionalContext` collection on {@link HookBus.emitChain}.
 *
 * Contract: a chain listener may return `{additionalContext: string[]}`,
 * alone or with `payload` and/or `halt`. The bus collects the strings in
 * listener order. `ChainEmitResult.additionalContext` is always an array.
 */

import { describe, expect, test } from "bun:test"

import { HookBus } from "./hook-bus.ts"

const noLog = () => {}

function chainBus(): HookBus {
  const bus = new HookBus(noLog)
  bus.declare("c", "chain")
  return bus
}

describe("HookBus / chain additionalContext", () => {
  test("is an empty array when no listener returns context", async () => {
    const bus = chainBus()
    bus.on("c", () => ({ payload: 2 }))
    const r = await bus.emitChain<number>("c", 1)
    expect(r.additionalContext).toEqual([])
  })

  test("is an empty array with no listeners and after dispose", async () => {
    const bus = chainBus()
    expect((await bus.emitChain("c", 1)).additionalContext).toEqual([])
    bus.dispose()
    expect((await bus.emitChain("c", 1)).additionalContext).toEqual([])
  })

  test("collects context in listener order (priority, then FIFO)", async () => {
    const bus = chainBus()
    bus.on("c", () => ({ additionalContext: ["lo"] }), { priority: 10 })
    bus.on("c", () => ({ additionalContext: ["hi-1", "hi-2"] }), { priority: 90 })
    bus.on("c", () => ({ additionalContext: ["mid"] }), { priority: 50 })
    bus.on("c", () => undefined, { priority: 40 })
    const r = await bus.emitChain("c", { x: 1 })
    expect(r.additionalContext).toEqual(["hi-1", "hi-2", "mid", "lo"])
    expect(r.payload).toEqual({ x: 1 })
    expect(r.halted).toBe(false)
  })

  test("context alone keeps the payload unchanged", async () => {
    const bus = chainBus()
    bus.on("c", () => ({ additionalContext: ["note"] }))
    const r = await bus.emitChain("c", { x: 1 })
    expect(r.payload).toEqual({ x: 1 })
    expect(r.additionalContext).toEqual(["note"])
  })

  test("context with payload rewrites and collects", async () => {
    const bus = chainBus()
    bus.on("c", (n: number) => ({ payload: n + 1, additionalContext: ["a"] }), { priority: 90 })
    bus.on("c", (n: number) => ({ payload: n * 10, additionalContext: ["b"] }), { priority: 10 })
    const r = await bus.emitChain<number>("c", 1)
    expect(r.payload).toBe(20)
    expect(r.additionalContext).toEqual(["a", "b"])
  })

  test("halt keeps context up to and including the halting listener", async () => {
    const bus = chainBus()
    bus.on("c", () => ({ additionalContext: ["before"] }), { priority: 90 })
    bus.on("c", () => ({ halt: true, reason: "no", additionalContext: ["halter"] }), {
      priority: 50,
      source: "gate",
    })
    bus.on("c", () => ({ additionalContext: ["after"] }), { priority: 10 })
    const r = await bus.emitChain("c", "x")
    expect(r.halted).toBe(true)
    expect(r.haltedBy).toBe("gate")
    expect(r.reason).toBe("no")
    expect(r.additionalContext).toEqual(["before", "halter"])
  })

  test("payload + halt + context", async () => {
    const bus = chainBus()
    bus.on("c", () => ({ payload: 5, halt: true, additionalContext: ["why"] }))
    const r = await bus.emitChain<number>("c", 1)
    expect(r).toMatchObject({ payload: 5, halted: true, additionalContext: ["why"] })
  })

  test("non-string items are skipped for a normal listener", async () => {
    const bus = chainBus()
    bus.on("c", () => ({ additionalContext: ["ok", 3, null] as unknown as string[] }))
    const r = await bus.emitChain("c", {})
    expect(r.additionalContext).toEqual(["ok"])
  })

  test("observeOnly listener context is ignored", async () => {
    const bus = chainBus()
    bus.on("c", () => ({ additionalContext: ["x"] }), { observeOnly: true })
    const r = await bus.emitChain("c", {})
    expect(r.additionalContext).toEqual([])
  })

  test("failClosed listener: context-only result is well formed and allows", async () => {
    const bus = chainBus()
    bus.on("c", () => ({ additionalContext: ["gate ok"] }), { failClosed: true })
    const r = await bus.emitChain("c", { x: 1 })
    expect(r.halted).toBe(false)
    expect(r.additionalContext).toEqual(["gate ok"])
  })

  test("failClosed listener: malformed context denies and keeps prior context", async () => {
    const bus = chainBus()
    bus.on("c", () => ({ additionalContext: ["first"] }), { priority: 90 })
    bus.on("c", () => ({ additionalContext: "bad" as unknown as string[] }), {
      priority: 10,
      failClosed: true,
      source: "gate",
    })
    const r = await bus.emitChain("c", { x: 1 })
    expect(r.halted).toBe(true)
    expect(r.haltedBy).toBe("gate")
    expect(JSON.stringify(r.failure)).toContain("malformed additionalContext")
    expect(r.additionalContext).toEqual(["first"])
  })

  test("failClosed listener that throws keeps prior context on the deny", async () => {
    const bus = chainBus()
    bus.on("c", () => ({ additionalContext: ["first"] }), { priority: 90 })
    bus.on(
      "c",
      () => {
        throw new Error("boom")
      },
      { priority: 10, failClosed: true },
    )
    const r = await bus.emitChain("c", {})
    expect(r.halted).toBe(true)
    expect(r.additionalContext).toEqual(["first"])
  })
})

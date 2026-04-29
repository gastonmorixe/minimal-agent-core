/**
 * Unit tests for {@link HookBus}.
 *
 * Covers chain ordering/halt/mutate/timeout/observeOnly, sync error
 * isolation, stream multicast + lifecycle, and dispose semantics.
 */

import { describe, expect, test } from "bun:test"
import { HookBus } from "./hook-bus.ts"

const noLog = (_: string) => {}

describe("HookBus / chain", () => {
  test("threads payload through listeners in priority order (high first)", async () => {
    const bus = new HookBus(noLog)
    bus.declare("c", "chain")
    const trace: string[] = []
    bus.on("c", (n: number) => {
      trace.push(`hi:${n}`)
      return { payload: n + 1 }
    }, { priority: 90, source: "hi" })
    bus.on("c", (n: number) => {
      trace.push(`lo:${n}`)
      return { payload: n * 10 }
    }, { priority: 10, source: "lo" })

    const r = await bus.emitChain<number>("c", 1)
    expect(trace).toEqual(["hi:1", "lo:2"])
    expect(r.payload).toBe(20)
    expect(r.halted).toBe(false)
  })

  test("FIFO on equal priority", async () => {
    const bus = new HookBus(noLog)
    bus.declare("c", "chain")
    const trace: string[] = []
    bus.on("c", () => {
      trace.push("a")
    }, { priority: 50, source: "a" })
    bus.on("c", () => {
      trace.push("b")
    }, { priority: 50, source: "b" })
    await bus.emitChain("c", null)
    expect(trace).toEqual(["a", "b"])
  })

  test("void return is pass-through", async () => {
    const bus = new HookBus(noLog)
    bus.declare("c", "chain")
    bus.on("c", () => {
      /* no return */
    })
    const r = await bus.emitChain("c", { x: 1 })
    expect(r.payload).toEqual({ x: 1 })
  })

  test("halt stops the chain and reports source + reason", async () => {
    const bus = new HookBus(noLog)
    bus.declare("c", "chain")
    let downstreamCalled = false
    bus.on("c", () => ({ halt: true, reason: "nope" }), {
      priority: 90,
      source: "blocker",
    })
    bus.on("c", () => {
      downstreamCalled = true
    }, { priority: 10 })
    const r = await bus.emitChain("c", "x")
    expect(r.halted).toBe(true)
    expect(r.haltedBy).toBe("blocker")
    expect(r.reason).toBe("nope")
    expect(downstreamCalled).toBe(false)
  })

  test("listener throwing is logged and treated as pass-through", async () => {
    const logs: string[] = []
    const bus = new HookBus((m) => logs.push(m))
    bus.declare("c", "chain")
    bus.on("c", () => {
      throw new Error("boom")
    }, { priority: 90 })
    bus.on("c", (n: number) => ({ payload: n + 1 }), { priority: 10 })
    const r = await bus.emitChain<number>("c", 1)
    expect(r.payload).toBe(2)
    expect(logs.join("\n")).toContain("boom")
  })

  test("observeOnly listener cannot mutate", async () => {
    const logs: string[] = []
    const bus = new HookBus((m) => logs.push(m))
    bus.declare("c", "chain")
    bus.on(
      "c",
      (n: number) => ({ payload: n + 999 }),
      { observeOnly: true, priority: 90 },
    )
    bus.on("c", (n: number) => ({ payload: n + 1 }), { priority: 10 })
    const r = await bus.emitChain<number>("c", 0)
    expect(r.payload).toBe(1)
    expect(logs.join("\n")).toContain("observeOnly")
  })

  test("timeoutMs skips a slow listener", async () => {
    const logs: string[] = []
    const bus = new HookBus((m) => logs.push(m))
    bus.declare("c", "chain")
    bus.on(
      "c",
      async () => {
        await new Promise((r) => setTimeout(r, 100))
        return { payload: "slow" }
      },
      { timeoutMs: 10, priority: 90 },
    )
    bus.on("c", (s: string) => ({ payload: `${s}!` }), { priority: 10 })
    const r = await bus.emitChain<string>("c", "ok")
    expect(r.payload).toBe("ok!")
    expect(logs.join("\n")).toContain("timeout")
  })

  test("dispose makes emitChain a no-op", async () => {
    const bus = new HookBus(noLog)
    bus.declare("c", "chain")
    let called = false
    bus.on("c", () => {
      called = true
    })
    bus.dispose()
    const r = await bus.emitChain("c", 1)
    expect(called).toBe(false)
    expect(r.payload).toBe(1)
  })

  test("disposer removes the listener", async () => {
    const bus = new HookBus(noLog)
    bus.declare("c", "chain")
    let n = 0
    const off = bus.on("c", () => {
      n++
    })
    await bus.emitChain("c", null)
    off()
    await bus.emitChain("c", null)
    expect(n).toBe(1)
    expect(bus.listenerCount("c")).toBe(0)
  })
})

describe("HookBus / broadcast-sync", () => {
  test("runs all listeners inline in priority order", () => {
    const bus = new HookBus(noLog)
    bus.declare("k", "broadcast-sync")
    const trace: string[] = []
    bus.on("k", () => trace.push("lo"), { priority: 10 })
    bus.on("k", () => trace.push("hi"), { priority: 90 })
    bus.emitSync("k", null)
    expect(trace).toEqual(["hi", "lo"])
  })

  test("error in one listener does not break the others", () => {
    const logs: string[] = []
    const bus = new HookBus((m) => logs.push(m))
    bus.declare("k", "broadcast-sync")
    bus.on("k", () => {
      throw new Error("nope")
    }, { priority: 90 })
    let called = false
    bus.on("k", () => {
      called = true
    }, { priority: 10 })
    bus.emitSync("k", null)
    expect(called).toBe(true)
    expect(logs.join("\n")).toContain("nope")
  })
})

describe("HookBus / stream", () => {
  test("multicasts pushed values to every subscriber until close", async () => {
    const bus = new HookBus(noLog)
    bus.declare("s", "stream")
    const a: number[] = []
    const b: number[] = []
    bus.on("s", async (it: AsyncIterable<number>) => {
      for await (const v of it) a.push(v)
    })
    bus.on("s", async (it: AsyncIterable<number>) => {
      for await (const v of it) b.push(v)
    })
    const h = bus.openStream<number>("s")
    h.push(1)
    h.push(2)
    h.push(3)
    h.close()
    await h.finished
    expect(a).toEqual([1, 2, 3])
    expect(b).toEqual([1, 2, 3])
  })

  test("close before push completes empty iterables", async () => {
    const bus = new HookBus(noLog)
    bus.declare("s", "stream")
    let count = 0
    bus.on("s", async (it: AsyncIterable<number>) => {
      for await (const _ of it) count++
    })
    const h = bus.openStream<number>("s")
    h.close()
    await h.finished
    expect(count).toEqual(0)
  })

  test("listener exception is isolated", async () => {
    const logs: string[] = []
    const bus = new HookBus((m) => logs.push(m))
    bus.declare("s", "stream")
    bus.on("s", async () => {
      throw new Error("bad-sub")
    })
    let ok: number[] = []
    bus.on("s", async (it: AsyncIterable<number>) => {
      for await (const v of it) ok.push(v)
    })
    const h = bus.openStream<number>("s")
    h.push(7)
    h.close()
    await h.finished
    expect(ok).toEqual([7])
    expect(logs.join("\n")).toContain("bad-sub")
  })
})

describe("HookBus / declare", () => {
  test("redeclare with mismatched shape throws", () => {
    const bus = new HookBus(noLog)
    bus.declare("x", "chain")
    expect(() => bus.declare("x", "stream")).toThrow(/already declared/)
  })

  test("emit with shape that conflicts with declare throws", () => {
    const bus = new HookBus(noLog)
    bus.declare("x", "chain")
    expect(() => bus.emitSync("x", null)).toThrow(/declared as "chain"/)
  })
})

import { describe, expect, test } from "bun:test"
import { Hooks } from "./hooks.ts"

const noLog = (_: string) => {}

describe("Hooks facade", () => {
  test("routes broadcast-async to EventBus", async () => {
    const h = new Hooks({ logger: noLog })
    let payload: unknown = null
    h.on("turn.didEnd", (p) => {
      payload = p
    }, { caller: "agent" })
    h.emitAsync("turn.didEnd", { ok: 1 })
    // EventBus is microtask-deferred
    await Promise.resolve()
    await Promise.resolve()
    expect(payload).toEqual({ ok: 1 })
  })

  test("routes chain to HookBus and awaits", async () => {
    const h = new Hooks({ logger: noLog })
    h.on("turn.willStart", (n: number) => ({ payload: n + 1 }), {
      caller: "agent",
      priority: 5000,
    })
    const r = await h.emitChain<number>("turn.willStart", 0)
    expect(r.payload).toBe(1)
  })

  test("rejects emit/listen on unknown channel", () => {
    const h = new Hooks({ logger: noLog })
    expect(() => h.on("nope.unknown", () => {})).toThrow(/unknown channel/)
    expect(() => h.emitAsync("nope.unknown")).toThrow(/unknown channel/)
  })

  test("rejects shape mismatch on emit", () => {
    const h = new Hooks({ logger: noLog })
    // turn.willStart is chain
    expect(() => h.emitAsync("turn.willStart")).toThrow(/shape "chain"/)
  })

  test("plugin priority is clamped to [0..100] without UNSAFE_HOOKS", async () => {
    const logs: string[] = []
    const h = new Hooks({ logger: (m) => logs.push(m), unsafeHooks: false })
    let runs = 0
    let lastPrio: number | null = null
    h.on(
      "turn.willStart",
      (_n, ctx) => {
        runs++
        lastPrio = (ctx as { priority: number }).priority
      },
      { caller: "plugin", priority: 99999, source: "evil" },
    )
    await h.emitChain("turn.willStart", 1)
    expect(runs).toBe(1)
    expect(lastPrio).toBe(100)
    expect(logs.join("\n")).toContain("clamped priority")
  })

  test("UNSAFE_HOOKS lets plugin priority into the agent band", async () => {
    const h = new Hooks({ logger: noLog, unsafeHooks: true })
    let prio: number | null = null
    h.on(
      "turn.willStart",
      (_n, ctx) => {
        prio = (ctx as { priority: number }).priority
      },
      { caller: "plugin", priority: 5000 },
    )
    await h.emitChain("turn.willStart", 1)
    expect(prio).toBe(5000)
  })

  test("agent listener runs after plugin listener at higher priority", async () => {
    const h = new Hooks({ logger: noLog })
    const order: string[] = []
    h.on(
      "turn.willStart",
      (_n) => {
        order.push("plugin")
      },
      { caller: "plugin", priority: 100 },
    )
    h.on(
      "turn.willStart",
      (_n) => {
        order.push("agent")
      },
      { caller: "agent", priority: 5000 },
    )
    await h.emitChain("turn.willStart", 1)
    expect(order).toEqual(["agent", "plugin"])
  })

  test("declare() adds runtime channels", async () => {
    const h = new Hooks({ logger: noLog })
    h.declare("custom.thing", "chain")
    let saw: number | null = null
    h.on("custom.thing", (n: number) => {
      saw = n
    }, { caller: "agent", priority: 5000 })
    await h.emitChain("custom.thing", 42)
    expect(saw).toBe(42)
  })

  test("declare() rejects re-declaring catalog channels", () => {
    const h = new Hooks({ logger: noLog })
    expect(() => h.declare("turn.willStart", "stream")).toThrow(/in the catalog/)
  })
})

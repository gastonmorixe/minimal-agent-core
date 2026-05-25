import { describe, expect, test } from "bun:test"
import { Hooks } from "./hooks.ts"

const noLog = (_: string) => {}

describe("Hooks facade", () => {
  test("routes broadcast-async to EventBus", async () => {
    const h = new Hooks({ logger: noLog })
    let payload: unknown = null
    h.on(
      "turn.didEnd",
      (p) => {
        payload = p
      },
      { caller: "agent" },
    )
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
    expect(() => h.on("nope.unknown", () => {}, { caller: "plugin" })).toThrow(/unknown channel/)
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
    let lastPrio = -1
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

  test("agent listener registered with caller:'agent' keeps its priority (regression: do not confuse 'source' with 'caller')", async () => {
    // Regression for src/agent.ts:editor.buffer.set, where the registration
    // opt key was `source: "agent"` instead of `caller: "agent"`. Since
    // `Hooks.on()` reads `opts.caller ?? "plugin"`, the typo silently
    // misclassified the listener as a plugin caller, then clamped the
    // requested priority 5000 down to 100 with a noisy log line.
    //
    // This test pins the contract from the AGENT side: any code path that
    // wants the agent privilege band MUST pass `caller: "agent"`. If a
    // future refactor renames the field, the warning should fire and this
    // test should break loudly.
    const logs: string[] = []
    const h = new Hooks({ logger: (m) => logs.push(m), unsafeHooks: false })
    let prio = -1
    h.on(
      "turn.willStart",
      (_n, ctx) => {
        prio = (ctx as { priority: number }).priority
      },
      { caller: "agent", priority: 5000, label: "agent:test" },
    )
    await h.emitChain("turn.willStart", 1)
    expect(prio).toBe(5000)
    expect(logs.join("\n")).not.toContain("clamped priority")
  })

  test("typo regression: passing 'source' instead of 'caller' falls through to plugin band and clamps", () => {
    // Documents the exact failure mode that bit src/agent.ts. If someone
    // re-introduces the typo, the misclassification is silent in code but
    // loud in this assertion: the listener registers in the plugin band
    // (clamped to 100), not at the requested 5000.
    const logs: string[] = []
    const h = new Hooks({ logger: (m) => logs.push(m), unsafeHooks: false })
    h.on(
      "turn.willStart",
      () => undefined,
      // @ts-expect-error: 'source' is a label, not the caller-kind field.
      // The cast simulates the historical typo at src/agent.ts:3084.
      { source: "agent", priority: 5000 },
    )
    expect(logs.join("\n")).toContain("clamped priority 5000 -> [0..100]")
  })

  test("UNSAFE_HOOKS lets plugin priority into the agent band", async () => {
    const h = new Hooks({ logger: noLog, unsafeHooks: true })
    let prio = -1
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
    let saw = -1
    h.on(
      "custom.thing",
      (n: number) => {
        saw = n
      },
      { caller: "agent", priority: 5000 },
    )
    await h.emitChain("custom.thing", 42)
    expect(saw).toBe(42)
  })

  test("declare() rejects re-declaring catalog channels", () => {
    const h = new Hooks({ logger: noLog })
    expect(() => h.declare("turn.willStart", "stream")).toThrow(/in the catalog/)
  })
})

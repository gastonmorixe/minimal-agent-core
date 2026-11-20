/**
 * 15e.2 safety: a halt is a deny by its `action`, never by its reason text.
 * Core writes no default deny text: a halt with no reason gives reason "",
 * and the deny carries the facts (pluginId, failure) for the host.
 */
import { describe, expect, test } from "bun:test"

import { Hooks } from "../plugins/hooks/hooks.ts"
import { deniedError, isDenied } from "../sdk/lifecycle.ts"

import { LifecyclePortAdapter } from "./lifecycle-port-adapter.ts"

const SEND = { messages: [], system: "sys", model: "m" }

describe("LifecyclePortAdapter deny facts (no default text)", () => {
  test("a halt with no reason is still a deny, with reason '' and the plugin id", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("message.willSend", () => ({ halt: true as const }), {
      caller: "plugin",
      priority: 50,
      source: "acme",
    })
    const d = await new LifecyclePortAdapter(hooks).beforeSend!(SEND)
    expect(d.action).toBe("deny")
    expect(isDenied(d)).toBe(true)
    if (d.action !== "deny") throw new Error("unreachable")
    expect(d.reason).toBe("")
    expect(d.pluginId).toBe("acme")
    const err = deniedError("message.willSend", d)
    expect(err.message).toBe("")
    expect(err.toJSON()).toEqual({
      kind: "LifecycleDeniedError",
      fields: { hook: "message.willSend", pluginId: "acme", additionalContext: [] },
    })
  })

  test("the same holds on tool.didBatch and compact.willRun", async () => {
    const hooks = new Hooks({ logger: () => {} })
    const opts = { caller: "plugin" as const, priority: 50, source: "p" }
    hooks.on("tool.didBatch", () => ({ halt: true as const, reason: "  " }), opts)
    hooks.on("compact.willRun", () => ({ halt: true as const }), opts)
    const port = new LifecyclePortAdapter(hooks)
    const batch = await port.afterToolBatch!({ results: [], round: 1 })
    const compact = await port.beforeCompact!({ reason: "manual", messagesBefore: 0 })
    expect(batch.action).toBe("deny")
    expect(compact.action).toBe("deny")
    expect(batch.action === "deny" ? batch.reason : "x").toBe("")
    expect(compact.action === "deny" ? compact.reason : "x").toBe("")
  })

  test("a failClosed listener that throws on message.willSend denies with the failure facts", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on(
      "message.willSend",
      () => {
        throw new Error("gate down")
      },
      { caller: "plugin", priority: 50, source: "hooks", label: "user:gate", failClosed: true },
    )
    const d = await new LifecyclePortAdapter(hooks).beforeSend!(SEND)
    expect(d.action).toBe("deny")
    if (d.action !== "deny") throw new Error("unreachable")
    expect(d.reason).toBe("")
    expect(d.failure?.label).toBe("user:gate")
    expect(d.failure?.detail).toContain("gate down")
    expect(deniedError("message.willSend", d).toJSON().fields.failure).toEqual({
      label: "user:gate",
      detail: "gate down",
    })
  })

  test("a broken emit with a failClosed listener on compact.willRun denies (no text)", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("compact.willRun", () => undefined, {
      caller: "plugin",
      priority: 50,
      source: "hooks",
      failClosed: true,
    })
    hooks.emitChain = () => Promise.reject(new Error("bus broke"))
    const d = await new LifecyclePortAdapter(hooks).beforeCompact!({
      reason: "manual",
      messagesBefore: 0,
    })
    expect(d.action).toBe("deny")
    if (d.action !== "deny") throw new Error("unreachable")
    expect(d.reason).toBe("")
    expect(d.failure).toEqual({ detail: "bus broke" })
  })
})

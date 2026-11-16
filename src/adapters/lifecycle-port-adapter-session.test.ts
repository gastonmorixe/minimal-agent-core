/**
 * {@link LifecyclePortAdapter} part 2 seams: `beforeTurnStop` emits
 * `turn.willStop`, and `sessionWillStart` emits `session.willStart`
 * (a halt is ignored, the context comes back).
 */

import { describe, expect, test } from "bun:test"

import { Hooks } from "../plugins/hooks/hooks.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"

import { LifecyclePortAdapter } from "./lifecycle-port-adapter.ts"

const PLUGIN = { caller: "plugin" as const, priority: 50, source: "test" }
const stopPayload = { lastAssistantText: "done", stopHookActive: false, sid: "s1" }
const startPayload = { source: "startup" as const, sid: "s1", cwd: "/", model: "m" }

describe("LifecyclePortAdapter.beforeTurnStop", () => {
  test("a halt with a reason and context is a deny with both", async () => {
    const hooks = new Hooks({ logger: () => {} })
    const seen: unknown[] = []
    hooks.on(
      "turn.willStop",
      (p) => {
        seen.push(p)
        return { halt: true as const, reason: "tests fail", additionalContext: ["see log"] }
      },
      PLUGIN,
    )
    const d = await new LifecyclePortAdapter(hooks).beforeTurnStop(stopPayload)
    expect(seen).toEqual([stopPayload])
    expect(d.action).toBe("deny")
    expect(d.action === "deny" ? d.reason : "").toBe("tests fail")
    expect(d.additionalContext).toEqual(["see log"])
  })

  test("no listener allows", async () => {
    const d = await new LifecyclePortAdapter(new Hooks({ logger: () => {} })).beforeTurnStop(
      stopPayload,
    )
    expect(d.action).toBe("allow")
  })
})

describe("LifecyclePortAdapter.sessionWillStart", () => {
  test("ignores a halt and returns the context", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("session.willStart", () => ({ additionalContext: ["first"] }), {
      ...PLUGIN,
      priority: 30,
    })
    hooks.on(
      "session.willStart",
      () => ({ halt: true as const, reason: "no", additionalContext: ["second"] }),
      { ...PLUGIN, priority: 20 },
    )
    const r = await new LifecyclePortAdapter(hooks).sessionWillStart(startPayload)
    expect(r).toEqual({ additionalContext: ["first", "second"] })
  })

  test("no listener returns an empty context", async () => {
    const r = await new LifecyclePortAdapter(new Hooks({ logger: () => {} })).sessionWillStart(
      startPayload,
    )
    expect(r).toEqual({ additionalContext: [] })
  })

  test("NOOP_LIFECYCLE returns an empty context and allows the stop", async () => {
    expect(await NOOP_LIFECYCLE.sessionWillStart?.(startPayload)).toEqual({
      additionalContext: [],
    })
    expect((await NOOP_LIFECYCLE.beforeTurnStop?.(stopPayload))?.action).toBe("allow")
  })
})

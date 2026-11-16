/**
 * `additionalContext` pass-through from the HookBus chain onto the
 * {@link LifecyclePortAdapter} results (PolicyDecision and afterTool).
 */

import { describe, expect, test } from "bun:test"

import { Hooks } from "../plugins/hooks/hooks.ts"
import { chainResultToDecision } from "../sdk/lifecycle.ts"
import { makeToolDidInvokePayload } from "../sdk/tool-lifecycle.ts"

import { LifecyclePortAdapter } from "./lifecycle-port-adapter.ts"

const PLUGIN = { caller: "plugin" as const, priority: 50, source: "test" }
const willPayload = { tool: "Bash", toolUseId: "1", input: { command: "ls" }, cwd: "/" }

describe("chainResultToDecision additionalContext", () => {
  test("allow carries the context", () => {
    const d = chainResultToDecision({ payload: 1, halted: false, additionalContext: ["a"] })
    expect(d).toEqual({ action: "allow", payload: 1, additionalContext: ["a"] })
  })

  test("deny carries the context", () => {
    const d = chainResultToDecision({
      payload: 1,
      halted: true,
      reason: "no",
      additionalContext: ["b"],
    })
    expect(d).toEqual({ action: "deny", reason: "no", payload: 1, additionalContext: ["b"] })
  })

  test("empty context leaves the field out", () => {
    const d = chainResultToDecision({ payload: 1, halted: false, additionalContext: [] })
    expect(d).toEqual({ action: "allow", payload: 1 })
  })
})

describe("LifecyclePortAdapter additionalContext", () => {
  test("beforeTool: context-only listener → allow with context", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("tool.willInvoke", () => ({ additionalContext: ["remember X"] }), PLUGIN)
    const d = await new LifecyclePortAdapter(hooks).beforeTool(willPayload)
    expect(d.action).toBe("allow")
    expect(d.additionalContext).toEqual(["remember X"])
  })

  test("beforeTool: halt with context → deny with context", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on(
      "tool.willInvoke",
      () => ({ halt: true as const, reason: "no", additionalContext: ["why"] }),
      PLUGIN,
    )
    const d = await new LifecyclePortAdapter(hooks).beforeTool(willPayload)
    expect(d.action).toBe("deny")
    expect(d.additionalContext).toEqual(["why"])
  })

  test("beforeTurn: payload with context → allow with both", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on(
      "turn.willStart",
      (p: { text: string }) => ({ payload: { text: `${p.text}!` }, additionalContext: ["c"] }),
      PLUGIN,
    )
    const d = await new LifecyclePortAdapter(hooks).beforeTurn({ text: "hi" })
    expect(d).toEqual({ action: "allow", payload: { text: "hi!" }, additionalContext: ["c"] })
  })

  test("afterTool returns the tool.didInvoke context", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("tool.didInvoke", () => ({ additionalContext: ["post"] }), PLUGIN)
    const payload = makeToolDidInvokePayload({ tool: "Bash", input: {}, cwd: "/", ok: true })
    const r = await new LifecyclePortAdapter(hooks).afterTool(payload)
    expect(r.additionalContext).toEqual(["post"])
    expect(r.tool).toBe("Bash")
  })

  test("afterTool without context returns the payload as is", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("tool.didInvoke", () => undefined, PLUGIN)
    const payload = makeToolDidInvokePayload({ tool: "Bash", input: {}, cwd: "/", ok: false })
    const r = await new LifecyclePortAdapter(hooks).afterTool(payload)
    expect(r.additionalContext).toBeUndefined()
    expect(r.isError).toBe(true)
  })
})

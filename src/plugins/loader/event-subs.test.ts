/**
 * `registerHookSub` and the `failClosed` manifest flag: a flagged chain
 * hook that throws (sync or async) halts the chain. An unflagged hook
 * that throws keeps today's pass-through behavior.
 */

import { describe, expect, test } from "bun:test"

import type { ResolvedHookSub } from "@minimal-agent/core/plugin-api/types/plugin"

import { Hooks } from "../hooks/hooks.ts"

import { registerHookSub } from "./event-subs.ts"

function sub(invoke: ResolvedHookSub["invoke"], failClosed?: boolean): ResolvedHookSub {
  return {
    definition: {
      id: "gate",
      channel: "tool.willInvoke",
      handler: { type: "module", path: "./gate.ts" },
      ...(failClosed !== undefined ? { failClosed } : {}),
    },
    entryAbsolute: "/pkg/gate.ts",
    invoke,
  }
}

const payload = { tool: "Bash", toolUseId: "1", input: {}, cwd: "/" }

describe("registerHookSub / failClosed", () => {
  test("a sync throw in a failClosed hook halts the chain", async () => {
    const hooks = new Hooks({ logger: () => {} })
    const throwing = (): never => {
      throw new Error("sync boom")
    }
    registerHookSub(hooks, "/pkg", sub(throwing, true), () => {}, "acp", undefined)
    const r = await hooks.emitChain("tool.willInvoke", payload)
    expect(r.halted).toBe(true)
    expect(JSON.stringify(r.failure)).toContain("sync boom")
  })

  test("an async rejection in a failClosed hook halts the chain", async () => {
    const hooks = new Hooks({ logger: () => {} })
    const rejecting = () => Promise.reject(new Error("async boom"))
    registerHookSub(hooks, "/pkg", sub(rejecting, true), () => {}, "acp", undefined)
    const r = await hooks.emitChain("tool.willInvoke", payload)
    expect(r.halted).toBe(true)
    expect(JSON.stringify(r.failure)).toContain("async boom")
  })

  test("a sync throw in an unflagged hook is logged and passes through", async () => {
    const hooks = new Hooks({ logger: () => {} })
    const logs: string[] = []
    const throwing = (): never => {
      throw new Error("sync boom")
    }
    registerHookSub(hooks, "/pkg", sub(throwing), (m) => logs.push(m), "other", undefined)
    const r = await hooks.emitChain("tool.willInvoke", payload)
    expect(r.halted).toBe(false)
    expect(logs.join("\n")).toContain("sync boom")
  })
})

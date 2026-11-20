/**
 * `registerHookSub` and the `failClosed` manifest flag: a flagged chain
 * hook that throws (sync or async) halts the chain. An unflagged hook
 * that throws keeps today's pass-through behavior.
 */

import { describe, expect, test } from "bun:test"

import type {
  HookHandlerContext,
  ResolvedHookSub,
} from "@minimal-agent/core/plugin-api/types/plugin"

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

describe("registerHookSub / ctx.run", () => {
  test("the hook ctx has run when the runMode getter is set", async () => {
    const hooks = new Hooks({ logger: () => {} })
    const seen: HookHandlerContext[] = []
    const spy = (_p: unknown, ctx: HookHandlerContext): undefined => {
      seen.push(ctx)
      return undefined
    }
    const runMode = () => ({ mode: "one-shot" as const, interactive: false })
    registerHookSub(
      hooks,
      "/pkg",
      sub(spy),
      () => {},
      "p",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        runMode,
        env: {},
      },
    )
    await hooks.emitChain("tool.willInvoke", payload)
    expect(seen[0]?.run).toEqual({ mode: "one-shot", interactive: false })
  })

  test("the hook ctx has no run when no getter and no sub-agent env", async () => {
    const hooks = new Hooks({ logger: () => {} })
    const seen: HookHandlerContext[] = []
    const spy = (_p: unknown, ctx: HookHandlerContext): undefined => {
      seen.push(ctx)
      return undefined
    }
    registerHookSub(
      hooks,
      "/pkg",
      sub(spy),
      () => {},
      "p",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        env: {},
      },
    )
    await hooks.emitChain("tool.willInvoke", payload)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.run).toBeUndefined()
  })

  test("a worker env gives mode subagent on the hook ctx", async () => {
    const hooks = new Hooks({ logger: () => {} })
    const seen: HookHandlerContext[] = []
    const spy = (_p: unknown, ctx: HookHandlerContext): undefined => {
      seen.push(ctx)
      return undefined
    }
    registerHookSub(
      hooks,
      "/pkg",
      sub(spy),
      () => {},
      "p",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        env: { MINIMAL_AGENT_SUBAGENT_ID: "A1" },
      },
    )
    await hooks.emitChain("tool.willInvoke", payload)
    expect(seen[0]?.run?.mode).toBe("subagent")
    expect(seen[0]?.run?.interactive).toBe(false)
  })

  test("ctx.run is lazy: a hook that does not read it does not call the getter", async () => {
    const hooks = new Hooks({ logger: () => {} })
    let calls = 0
    const runMode = () => {
      calls++
      return { mode: "one-shot" as const, interactive: false }
    }
    let read: HookHandlerContext | undefined
    const quiet = (_p: unknown, ctx: HookHandlerContext): undefined => {
      read = ctx
      return undefined
    }
    registerHookSub(
      hooks,
      "/pkg",
      sub(quiet),
      () => {},
      "p",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        runMode,
        env: {},
      },
    )
    await hooks.emitChain("tool.willInvoke", payload)
    expect(calls).toBe(0)
    expect(read?.run?.mode).toBe("one-shot")
    expect(read?.run?.mode).toBe("one-shot")
    expect(calls).toBe(1)
  })
})

import { describe, expect, test } from "bun:test"

import { Hooks } from "../plugins/hooks/hooks.ts"

import { createLifecyclePort, LifecyclePortAdapter } from "./lifecycle-port-adapter.ts"

describe("LifecyclePortAdapter", () => {
  test("null hooks → NOOP allow", async () => {
    const port = createLifecyclePort(null)
    const d = await port.beforeTool!({
      tool: "Write",
      toolUseId: "1",
      input: { file_path: "/a", content: "x" },
      cwd: "/",
    })
    expect(d.action).toBe("allow")
  })

  test("willInvoke halt → deny", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("tool.willInvoke", () => ({ halt: true as const, reason: "no writes" }), {
      caller: "plugin",
      priority: 50,
      source: "test",
    })
    const port = new LifecyclePortAdapter(hooks)
    const d = await port.beforeTool!({
      tool: "Write",
      toolUseId: "1",
      input: {},
      cwd: "/",
    })
    expect(d.action).toBe("deny")
    if (d.action === "deny") expect(d.reason).toBe("no writes")
  })

  test("willInvoke payload rewrite → allow with new input", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on(
      "tool.willInvoke",
      (p: { tool: string; toolUseId: string; input: Record<string, unknown>; cwd: string }) => ({
        payload: { ...p, input: { ...p.input, command: "echo safe" } },
      }),
      { caller: "plugin", priority: 50, source: "test" },
    )
    const port = new LifecyclePortAdapter(hooks)
    const d = await port.beforeTool!({
      tool: "Bash",
      toolUseId: "1",
      input: { command: "rm -rf /" },
      cwd: "/",
    })
    expect(d.action).toBe("allow")
    if (d.action === "allow") expect(d.payload.input.command).toBe("echo safe")
  })

  test("beforeSend halt blocks", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("message.willSend", () => ({ halt: true as const, reason: "redact" }), {
      caller: "plugin",
      priority: 50,
      source: "test",
    })
    const port = new LifecyclePortAdapter(hooks)
    const d = await port.beforeSend!({
      messages: [],
      system: "sys",
      model: "m",
    })
    expect(d.action).toBe("deny")
  })
  test("willInvoke failClosed listener throws → deny with a reason", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on(
      "tool.willInvoke",
      () => {
        throw new Error("client gone")
      },
      { caller: "plugin", priority: 50, source: "acp", failClosed: true },
    )
    const port = new LifecyclePortAdapter(hooks)
    const d = await port.beforeTool!({ tool: "Bash", toolUseId: "1", input: {}, cwd: "/" })
    expect(d.action).toBe("deny")
    if (d.action === "deny") expect(d.reason).toContain("client gone")
  })

  test("willInvoke unflagged listener throws → allow (today's behavior)", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on(
      "tool.willInvoke",
      () => {
        throw new Error("unrelated bug")
      },
      { caller: "plugin", priority: 50, source: "other" },
    )
    const port = new LifecyclePortAdapter(hooks)
    const d = await port.beforeTool!({ tool: "Bash", toolUseId: "1", input: {}, cwd: "/" })
    expect(d.action).toBe("allow")
  })

  test("willInvoke emit itself throws with a failClosed listener → deny", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("tool.willInvoke", () => undefined, {
      caller: "plugin",
      priority: 50,
      source: "acp",
      failClosed: true,
    })
    hooks.emitChain = () => Promise.reject(new Error("bus broke"))
    const port = new LifecyclePortAdapter(hooks)
    const d = await port.beforeTool!({ tool: "Bash", toolUseId: "1", input: {}, cwd: "/" })
    expect(d.action).toBe("deny")
  })

  test("willInvoke emit itself throws with no failClosed listener → allow", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("tool.willInvoke", () => undefined, { caller: "plugin", priority: 50, source: "x" })
    hooks.emitChain = () => Promise.reject(new Error("bus broke"))
    const port = new LifecyclePortAdapter(hooks)
    const d = await port.beforeTool!({ tool: "Bash", toolUseId: "1", input: {}, cwd: "/" })
    expect(d.action).toBe("allow")
  })
})

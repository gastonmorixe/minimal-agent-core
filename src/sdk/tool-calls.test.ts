import { describe, expect, test } from "bun:test"

import type { ToolUseBlock } from "../llm/messages.ts"

import type { AgentEvent } from "./events.ts"
import type { ToolExecutor } from "./ports.ts"
import { runToolCalls } from "./tool-calls.ts"

function toolUse(id: string): ToolUseBlock {
  return { type: "tool_use", id, name: "Bash", input: { command: `echo ${id}` } }
}

describe("runToolCalls / abort between tool calls", () => {
  test("an abort after the first tool skips the rest with an aborted result", async () => {
    const ac = new AbortController()
    const ran: string[] = []
    const executor: ToolExecutor = {
      async execute(tool) {
        ran.push(tool.id)
        // session/cancel arrives while the first tool runs.
        ac.abort()
        return { content: "ok", isError: false }
      },
    }
    const events: AgentEvent[] = []
    const persisted: string[] = []
    const results = await runToolCalls(
      {
        executor,
        persistence: {
          appendToolResult: (r: { tool_use_id: string }) => persisted.push(r.tool_use_id),
        } as never,
        emit: (e) => events.push(e),
        wantsToolOutput: false,
        now: () => 0,
      },
      [toolUse("t1"), toolUse("t2"), toolUse("t3")],
      ac.signal,
    )
    expect(ran).toEqual(["t1"])
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1", "t2", "t3"])
    expect(results[0]?.is_error).toBe(false)
    for (const r of results.slice(1)) {
      expect(r.is_error).toBe(true)
      expect(r.content).toBe("tool aborted by user")
    }
    expect(persisted).toEqual(["t1", "t2", "t3"])
    // Each skipped call still opens and closes its item on the same id.
    const closed = events.filter((e) => e.type === "tool_result").map((e) => e.id)
    expect(closed).toEqual(["t1", "t2", "t3"])
    const running = events.filter((e) => e.type === "status")
    expect(running).toHaveLength(1)
  })

  test("a skipped call goes through appendSyntheticToolResult when the host has it", async () => {
    const ac = new AbortController()
    ac.abort()
    const real: string[] = []
    const synthetic: string[] = []
    await runToolCalls(
      {
        executor: { execute: async () => ({ content: "ok", isError: false }) },
        persistence: {
          appendToolResult: (r: { tool_use_id: string }) => real.push(r.tool_use_id),
          appendSyntheticToolResult: (r: { tool_use_id: string }) => synthetic.push(r.tool_use_id),
        } as never,
        emit: () => {},
        wantsToolOutput: false,
        now: () => 0,
      },
      [toolUse("t1"), toolUse("t2")],
      ac.signal,
    )
    expect(real).toEqual([])
    expect(synthetic).toEqual(["t1", "t2"])
  })

  test("no abort runs every tool", async () => {
    const ran: string[] = []
    const executor: ToolExecutor = {
      async execute(tool) {
        ran.push(tool.id)
        return { content: "ok", isError: false }
      },
    }
    const results = await runToolCalls(
      { executor, persistence: null, emit: () => {}, wantsToolOutput: false, now: () => 0 },
      [toolUse("t1"), toolUse("t2")],
      new AbortController().signal,
    )
    expect(ran).toEqual(["t1", "t2"])
    expect(results.every((r) => !r.is_error)).toBe(true)
  })
})

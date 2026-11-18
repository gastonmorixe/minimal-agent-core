import { describe, expect, test } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import type { ToolUseBlock } from "../llm/messages.ts"

import type { AgentEvent } from "./events.ts"
import type { ToolExecResult, ToolExecutor } from "./ports.ts"
import { runToolCalls } from "./tool-calls.ts"
import { internalOutcomeOf, withInternalOutcome } from "./tool-outcome-record.ts"

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

describe("runToolCalls / sideband mark (spec v6.1 D1 item 5)", () => {
  const run = (executor: ToolExecutor) => {
    const persisted: unknown[] = []
    return runToolCalls(
      {
        executor,
        persistence: { appendToolResult: (r: unknown) => persisted.push(r) } as never,
        emit: () => {},
        wantsToolOutput: false,
        now: () => 0,
      },
      [toolUse("t1")],
      undefined,
    ).then((results) => ({ results, persisted }))
  }

  test("the block keeps the mark that the executor returns", async () => {
    const { results, persisted } = await run({
      execute: async () => ({ content: "ok", isError: false, sideband: { kind: "k" } }),
    })
    expect(results[0]?.sideband).toEqual({ kind: "k" })
    expect(persisted[0]).toEqual(results[0])
  })

  test("with no mark the block has no sideband key (same bytes as before)", async () => {
    const { results } = await run({ execute: async () => ({ content: "ok", isError: false }) })
    const block = results[0]
    expect(block !== undefined && "sideband" in block).toBe(false)
    expect(JSON.stringify(block)).toBe(
      JSON.stringify({ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }),
    )
  })
})

describe("runToolCalls / persisted outcome (spec v6.1 D8 rule 8)", () => {
  const record = {
    v: 1 as const,
    bodyEnd: 2,
    annotations: [{ kind: "policy", start: 3, end: 6 }],
  }
  const run = (executor: ToolExecutor) => {
    const persisted: unknown[] = []
    return runToolCalls(
      {
        executor,
        persistence: { appendToolResult: (r: unknown) => persisted.push(r) } as never,
        emit: () => {},
        wantsToolOutput: false,
        now: () => 0,
      },
      [toolUse("t1")],
      undefined,
    ).then((results) => ({ results, persisted }))
  }

  test("the live block keeps the outcome of core's own executor (internal channel)", async () => {
    const { results, persisted } = await run({
      execute: async () => withInternalOutcome({ content: "ok\nabc", isError: false }, record),
    })
    expect(results[0]?.outcome).toEqual(record)
    expect(persisted[0]).toEqual(results[0])
  })

  test("a host executor that returns an outcome key gets a live block with no outcome (F18)", async () => {
    // The public ToolExecResult has no `outcome` field until M3. A host
    // object with the key (for example from JavaScript) is not read.
    const hostResult = { content: "ok\nabc", isError: false, outcome: record }
    const { results, persisted } = await run({ execute: async () => hostResult })
    const block = results[0]
    expect(block !== undefined && "outcome" in block).toBe(false)
    expect(persisted[0]).toEqual(block)
    expect(JSON.stringify(block)).toBe(
      JSON.stringify({
        type: "tool_result",
        tool_use_id: "t1",
        content: "ok\nabc",
        is_error: false,
      }),
    )
  })

  test("withInternalOutcome with undefined removes an old registration", () => {
    const result = withInternalOutcome({ content: "x", isError: false }, record)
    expect(internalOutcomeOf(result)).toBe(record)
    withInternalOutcome(result, undefined)
    expect(internalOutcomeOf(result)).toBeUndefined()
    expect(internalOutcomeOf({ outcome: record })).toBeUndefined()
  })

  test("with no outcome the block has no outcome key (same bytes as before)", async () => {
    const { results } = await run({ execute: async () => ({ content: "ok", isError: false }) })
    const block = results[0]
    expect(block !== undefined && "outcome" in block).toBe(false)
    expect(JSON.stringify(block)).toBe(
      JSON.stringify({ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }),
    )
  })
})

describe("runToolCalls / internal outcome checked against the content (review W2 M3)", () => {
  const record = {
    v: 1 as const,
    bodyEnd: 2,
    annotations: [{ kind: "policy", start: 3, end: 6 }],
  }
  const run = (executor: ToolExecutor) => {
    const events: LogEvent[] = []
    const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
    return runToolCalls(
      {
        executor,
        persistence: null,
        emit: () => {},
        wantsToolOutput: false,
        now: () => 0,
        diagnostics,
      },
      [toolUse("t1")],
      undefined,
    ).then((results) => ({ results, events }))
  }

  test("content changed in place after registration: no outcome, ONE record-dropped", async () => {
    const { results, events } = await run({
      execute: async () => {
        // core's executor registers the record, then a host wrapper changes
        // the content on the SAME object (for example a redaction).
        const result = withInternalOutcome({ content: "ok\nabc", isError: false }, record)
        result.content = "ok"
        return result
      },
    })
    const block = results[0]
    expect(block !== undefined && "outcome" in block).toBe(false)
    expect(block?.content).toBe("ok")
    const dropped = events.filter((e) => e.source === "tool-outcome.record-dropped")
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.structuredData).toEqual({ tool: "Bash", reason: "content-changed" })
    expect(events).toHaveLength(1)
  })

  test("a span edge that moves into new text also drops it", async () => {
    const { results, events } = await run({
      execute: async () => {
        const result: ToolExecResult = withInternalOutcome(
          { content: [{ type: "text", text: "ok\nabc" }], isError: false },
          record,
        )
        result.content = [{ type: "text", text: "o" }]
        return result
      },
    })
    expect(results[0]?.outcome).toBeUndefined()
    expect(events.filter((e) => e.source === "tool-outcome.record-dropped")).toHaveLength(1)
  })

  test("unchanged content keeps the outcome (deep-equal), with no diagnostic", async () => {
    const { results, events } = await run({
      execute: async () => withInternalOutcome({ content: "ok\nabc", isError: false }, record),
    })
    expect(results[0]?.outcome).toEqual(record)
    expect(events).toHaveLength(0)
  })
})

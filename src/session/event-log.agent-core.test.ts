/**
 * The session event log fed by a real `AgentCore` run, wired the way a
 * session host does it: the core's event sink appends to the log.
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"
import { AgentCore } from "../sdk/agent-core.ts"
import type { AgentEventType } from "../sdk/events.ts"
import type { ToolExecResult, ToolExecutor } from "../sdk/ports.ts"
import { SINK_ERROR_CODE } from "../sdk/sink-guard.ts"

import { type SessionEntry, SessionEventLog } from "./event-log.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

class StubExecutor implements ToolExecutor {
  async execute(): Promise<ToolExecResult> {
    return { content: "ok", isError: false }
  }
}

/** A core whose events go into `log`: one tool round, then a text answer. */
function coreFor(log: SessionEventLog): AgentCore {
  let round = 0
  const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round === 1) {
      return {
        blocks: [{ type: "tool_use" as const, id: "call-1", name: "DoThing", input: {} }],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    yield "done"
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    } as StreamedResponse
  }
  return new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [{ name: "DoThing", description: "d", input_schema: {} }] },
    toolExecutor: new StubExecutor(),
    sendFn,
    eventSink: { emit: (event) => log.appendEvent(event) },
  })
}

async function runToEnd(core: AgentCore, input: string): Promise<string | null> {
  const gen = core.run(input)
  while (true) {
    const { done, value } = await gen.next()
    if (done) return value.stopReason
  }
}

function eventTypes(entries: readonly SessionEntry[]): AgentEventType[] {
  return entries.flatMap((e) => (e.ch === "event" ? [e.data.type] : []))
}

describe("SessionEventLog with AgentCore", () => {
  it("a throwing subscriber does not stop the run and emits exactly one sink-error", async () => {
    const log = new SessionEventLog({ sessionId: "s" })
    log.subscribe(
      () => {
        throw new Error("frontend went away")
      },
      { name: "sse" },
    )
    const good: SessionEntry[] = []
    log.subscribe((e) => good.push(e))

    expect(await runToEnd(coreFor(log), "go")).toBe("end_turn")

    expect(eventTypes(good)).toContain("tool_result")
    // run_finished (S18) closes every run, after turn_completed.
    expect(eventTypes(good).at(-1)).toBe("run_finished")
    const reports = good.filter((e) => e.ch === "diag" && e.data.code === SINK_ERROR_CODE)
    expect(reports).toHaveLength(1)
    expect(good.map((e) => e.seq)).toEqual(good.map((_, i) => i))
  })

  it("two sessions in one process keep separate logs; subscribers resume from 0 and the middle", async () => {
    const a = new SessionEventLog({ sessionId: "a" })
    const b = new SessionEventLog({ sessionId: "b" })
    await Promise.all([runToEnd(coreFor(a), "one"), runToEnd(coreFor(b), "two")])

    const fromZero: SessionEntry[] = []
    a.subscribe((e) => fromZero.push(e), { fromSeq: 0 })
    const middle = Math.floor(b.stats().nextSeq / 2)
    const fromMiddle: SessionEntry[] = []
    b.subscribe((e) => fromMiddle.push(e), { fromSeq: middle })

    expect(fromZero.length).toBe(a.stats().nextSeq)
    expect(fromZero.every((e) => e.sessionId === "a")).toBe(true)
    expect(fromMiddle[0]?.seq).toBe(middle)
    expect(fromMiddle.at(-1)?.seq).toBe(b.stats().nextSeq - 1)
    expect(fromMiddle.every((e) => e.sessionId === "b")).toBe(true)
  })
})

/**
 * The legacy event filter (spec S18): a sink without an explicit `kinds`
 * list, like the `--json` route's default {@link JsonlEventSink}, emits
 * only the nine original kinds. A sink can opt into the newer kinds
 * (`user_message`, `status`, `tool_call`, `tool_output`, `quota`,
 * `run_finished`) by listing them.
 *
 * @module sdk/events-kinds.test
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import {
  type AgentEvent,
  type AgentEventType,
  ALL_EVENT_KINDS,
  JsonlEventSink,
  LEGACY_EVENT_KINDS,
} from "./events.ts"
import type { ToolExecResult } from "./ports.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

function toolTurnSend() {
  let round = 0
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round === 1) {
      return {
        blocks: [{ type: "tool_use" as const, id: "c1", name: "Grep", input: {} }],
        text: "",
        stopReason: "tool_use",
      }
    }
    yield "done"
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    }
  }
}

function toolTurnCore(eventSink: {
  emit: (e: AgentEvent) => void
  kinds?: readonly AgentEventType[]
}): AgentCore {
  const result: ToolExecResult = { content: "ok", isError: false }
  return new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [{ name: "Grep", description: "d", input_schema: {} }] },
    toolExecutor: { execute: async () => result },
    sendFn: toolTurnSend(),
    eventSink,
  })
}

async function drainRun(core: AgentCore, text: string): Promise<void> {
  const gen = core.run(text)
  while (!(await gen.next()).done) {
    // drain
  }
}

describe("event kind filtering (S18)", () => {
  it("the JSON route's default sink emits only the nine legacy kinds", async () => {
    const kinds = new Set<AgentEventType>()
    const sink = new JsonlEventSink(() => {}, LEGACY_EVENT_KINDS)
    const originalEmit = sink.emit.bind(sink)
    sink.emit = (e) => {
      kinds.add(e.type)
      originalEmit(e)
    }
    await drainRun(toolTurnCore(sink), "go")
    for (const k of kinds) expect(LEGACY_EVENT_KINDS).toContain(k)
    // Confirms the filter is doing real work: the run also produces kinds
    // outside the legacy nine (user_message, run_finished, ...), which this
    // sink must NOT see.
    expect(kinds.size).toBeLessThan(ALL_EVENT_KINDS.length)
  })

  it("a sink that lists every kind sees the new ones too", async () => {
    const seen: AgentEventType[] = []
    const sink = { emit: (e: AgentEvent) => seen.push(e.type), kinds: ALL_EVENT_KINDS }
    await drainRun(toolTurnCore(sink), "go")
    expect(seen).toContain("user_message")
    expect(seen).toContain("tool_call")
    expect(seen).toContain("tool_output")
    expect(seen).toContain("run_finished")
    expect(seen.at(0)).toBe("user_message")
    expect(seen.at(-1)).toBe("run_finished")
  })

  it("a sink without `kinds` gets everything except tool_output (back-compat default)", async () => {
    const seen: AgentEventType[] = []
    const sink = { emit: (e: AgentEvent) => seen.push(e.type) }
    await drainRun(toolTurnCore(sink), "go")
    expect(seen).toContain("user_message")
    expect(seen).toContain("run_finished")
    expect(seen).not.toContain("tool_output")
  })
})

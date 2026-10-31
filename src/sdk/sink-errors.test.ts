/**
 * S22: a throwing event sink does not stop the run, and no failure is silent.
 * The first throw emits exactly one `events.sink-error` diagnostic.
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { getDiagnosticBus, type LogEvent } from "../bus/diagnostic-bus.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import type { AgentEvent, EventSink } from "./events.ts"
import type { AgentCoreConfig, ToolExecResult, ToolExecutor } from "./ports.ts"
import { SINK_ERROR_CODE } from "./sink-guard.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

class StubExecutor implements ToolExecutor {
  async execute(): Promise<ToolExecResult> {
    return { content: "ok", isError: false }
  }
}

/** One tool round, then a text answer. */
function toolTurnSendFn(): AgentCoreConfig["sendFn"] {
  let round = 0
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round % 2 === 1) {
      return {
        blocks: [{ type: "tool_use" as const, id: `call-${round}`, name: "DoThing", input: {} }],
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
}

function coreWith(eventSink: EventSink): AgentCore {
  return new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [{ name: "DoThing", description: "d", input_schema: {} }] },
    toolExecutor: new StubExecutor(),
    transcriptSink: { write: () => {} },
    sendFn: toolTurnSendFn(),
    eventSink,
  })
}

async function drain(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<string> {
  let text = ""
  while (true) {
    const { done, value } = await gen.next()
    if (done) return value.stopReason ?? ""
    text += value
  }
}

/** Collect `events.sink-error` diagnostics from the process bus while `fn` runs. */
async function captureSinkErrors(fn: () => Promise<void>): Promise<LogEvent[]> {
  const seen: LogEvent[] = []
  const off = getDiagnosticBus().on(
    (e) => e.source === SINK_ERROR_CODE,
    (e) => seen.push(e),
  )
  try {
    await fn()
  } finally {
    off()
  }
  return seen
}

describe("S22: a throwing event sink does not stop the run", () => {
  it("completes the run and emits exactly one events.sink-error", async () => {
    let attempts = 0
    const sink: EventSink = {
      emit() {
        attempts++
        throw new Error("sink is broken")
      },
    }
    const core = coreWith(sink)
    let stop = ""
    const errors = await captureSinkErrors(async () => {
      stop = await drain(core.run("go"))
    })
    expect(stop).toBe("end_turn")
    // Every event reached the sink and threw; only the first was reported.
    expect(attempts).toBeGreaterThan(3)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.structuredData).toMatchObject({
      listener: "eventSink",
      error: "sink is broken",
    })
  })

  it("does not report again on a later run of the same core", async () => {
    const sink: EventSink = {
      emit() {
        throw new Error("still broken")
      },
    }
    const core = coreWith(sink)
    const errors = await captureSinkErrors(async () => {
      await drain(core.run("one"))
      await drain(core.run("two"))
    })
    expect(errors).toHaveLength(1)
  })

  it("keeps delivering after a throw, so a sink that recovers sees later events", async () => {
    const got: AgentEvent[] = []
    let first = true
    const sink: EventSink = {
      emit(event) {
        if (first) {
          first = false
          throw new Error("transient")
        }
        got.push(event)
      },
    }
    const core = coreWith(sink)
    const errors = await captureSinkErrors(async () => {
      await drain(core.run("go"))
    })
    expect(errors).toHaveLength(1)
    expect(got.map((e) => e.type)).toContain("tool_result")
    expect(got.at(-1)?.type).toBe("run_finished")
  })

  it("emits no events.sink-error when the sink never throws", async () => {
    const got: AgentEvent[] = []
    const core = coreWith({ emit: (e) => got.push(e) })
    const errors = await captureSinkErrors(async () => {
      await drain(core.run("go"))
    })
    expect(errors).toEqual([])
    expect(got.length).toBeGreaterThan(0)
  })
})

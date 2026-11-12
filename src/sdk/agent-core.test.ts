import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { type LogEvent, Severity } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import type { AgentEvent, EventSink } from "./events.ts"
import type {
  AgentCoreConfig,
  ToolDefinition,
  ToolExecResult,
  ToolExecutor,
  ToolRegistry,
} from "./ports.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/** An empty tool registry — the default for no-tools runs. */
const EMPTY_REGISTRY: ToolRegistry = {
  list: () => [],
}

/** A registry exposing a fixed list of tool definitions. */
function registryOf(tools: ToolDefinition[]): ToolRegistry {
  return { list: () => tools }
}

/** A tool executor that returns a canned result and records its calls. */
class StubExecutor implements ToolExecutor {
  calls: string[] = []
  constructor(private readonly result: ToolExecResult) {}
  async execute(toolUse: { name: string }): Promise<ToolExecResult> {
    this.calls.push(toolUse.name)
    return this.result
  }
}

function baseConfig(overrides: Partial<AgentCoreConfig>): AgentCoreConfig {
  return {
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: EMPTY_REGISTRY,
    toolExecutor: new StubExecutor({ content: "", isError: false }),
    ...overrides,
  }
}

async function drain(
  gen: AsyncGenerator<string, StreamedResponse, undefined>,
): Promise<{ text: string; final: StreamedResponse }> {
  let text = ""
  while (true) {
    const { done, value } = await gen.next()
    if (done) return { text, final: value }
    text += value
  }
}

describe("AgentCore.run — port injection", () => {
  it("adds a session-resumed attachment without an empty user-text block", async () => {
    let seen: import("../llm/messages.ts").Message[] = []
    const sendFn = async function* (opts: { messages: import("../llm/messages.ts").Message[] }) {
      seen = JSON.parse(JSON.stringify(opts.messages))
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const core = new AgentCore(baseConfig({ sendFn: sendFn as never }))

    core.noteSessionResumed()
    await drain(core.run(""))

    const user = seen.find((m) => m.role === "user")
    expect(user?.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("session-resumed") }),
    ])
  })

  it("streams a plain text reply with no tools and returns the final response", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "hello "
      yield "world"
      return {
        blocks: [{ type: "text" as const, text: "hello world" }],
        text: "hello world",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const core = new AgentCore(baseConfig({ sendFn }))
    const { text, final } = await drain(core.run("hi"))
    expect(text).toBe("hello world")
    expect(final.stopReason).toBe("end_turn")
    // The user turn + assistant turn both land in history.
    expect(core.history().length).toBe(2)
    expect(core.history()[0]?.role).toBe("user")
    expect(core.history()[1]?.role).toBe("assistant")
  })

  it("applies toolFilter when advertising tools to the transport", async () => {
    let seenToolNames: string[] | undefined
    const sendFn = async function* (opts: {
      tools?: Array<{ name: string }>
    }): AsyncGenerator<string, StreamedResponse, undefined> {
      seenToolNames = (opts.tools ?? []).map((t) => t.name)
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const core = new AgentCore(
      baseConfig({
        sendFn: sendFn as never,
        toolRegistry: registryOf([
          { name: "Read", description: "r", input_schema: {} },
          { name: "WebSearch", description: "w", input_schema: {} },
          { name: "Task", description: "t", input_schema: {} },
        ]),
        toolFilter: {
          filter: (tools) => tools.filter((t) => t.name === "WebSearch"),
        },
      }),
    )
    await drain(core.run("hi"))
    expect(seenToolNames).toEqual(["WebSearch"])
  })

  it("routes tool execution through the ToolExecutor port", async () => {
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        return {
          blocks: [{ type: "tool_use" as const, id: "call-1", name: "DoThing", input: { x: 1 } }],
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
    const executor = new StubExecutor({ content: "thing done", isError: false })
    const core = new AgentCore(
      baseConfig({
        sendFn,
        toolExecutor: executor,
        toolRegistry: registryOf([
          { name: "DoThing", description: "does the thing", input_schema: {} },
        ]),
      }),
    )
    const { text } = await drain(core.run("do it"))
    expect(text).toBe("done")
    expect(executor.calls).toEqual(["DoThing"])
    // The tool_result is paired into history as a user turn after the assistant tool_use.
    const roles = core.history().map((m) => m.role)
    expect(roles).toEqual(["user", "assistant", "user", "assistant"])
  })

  it("emits reflection-ack notices as notice events only", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      const text = '<ma::agent::reflection-ack silence-for="2" reason="batch" />'
      yield text
      return {
        blocks: [{ type: "text" as const, text }],
        text,
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const sink = new CaptureEventSink()
    const core = new AgentCore(baseConfig({ sendFn, eventSink: sink }))
    await drain(core.run("go"))
    const notices = sink.events.flatMap((e) => (e.type === "notice" ? [e.notice] : []))
    expect(notices.map((n) => n.kind)).toEqual(["reflection_ack"])
    expect(notices[0]).toMatchObject({ kind: "reflection_ack", severity: "info" })
    expect(notices[0]).toHaveProperty("silenceFor")
    expect(JSON.stringify(notices[0])).toContain("batch")
  })

  it("send() does a single round-trip without tools", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "plain reply"
      return {
        blocks: [{ type: "text" as const, text: "plain reply" }],
        text: "plain reply",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const core = new AgentCore(baseConfig({ sendFn }))
    const { text } = await drain(core.send("ping"))
    expect(text).toBe("plain reply")
    expect(core.history().length).toBe(2)
  })

  it("seeds initial messages for resume", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const core = new AgentCore(
      baseConfig({
        sendFn,
        initialMessages: [
          { role: "user", content: [{ type: "text", text: "earlier" }] },
          { role: "assistant", content: [{ type: "text", text: "prior reply" }] },
        ],
      }),
    )
    expect(core.history().length).toBe(2)
    await drain(core.run("next"))
    // 2 seeded + 1 user + 1 assistant
    expect(core.history().length).toBe(4)
  })
})

/** Collects every emitted AgentEvent. */
class CaptureEventSink implements EventSink {
  events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

describe("AgentCore.run — fatal provider errors", () => {
  it("emits an error event with code and hint, then rethrows", async () => {
    // biome-ignore lint/correctness/useYield: throws before the first chunk
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      throw Object.assign(new Error("paid model needs login"), {
        code: "x.login_required",
        hint: "run: log in",
      })
    }
    const sink = new CaptureEventSink()
    const core = new AgentCore(baseConfig({ sendFn, eventSink: sink }))
    await expect(drain(core.run("go"))).rejects.toThrow("paid model needs login")
    const errors = sink.events.filter((e) => e.type === "error")
    expect(errors).toEqual([
      {
        type: "error",
        message: "paid model needs login",
        code: "x.login_required",
        hint: "run: log in",
      },
    ])
  })
})

describe("AgentCore.run — structured event emission", () => {
  it("emits turn_started / item_started+completed / turn_completed for a text-only turn", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "hi"
      return {
        blocks: [{ type: "text" as const, text: "hi" }],
        text: "hi",
        stopReason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      } as StreamedResponse
    }
    const sink = new CaptureEventSink()
    const core = new AgentCore(baseConfig({ sendFn, eventSink: sink }))
    await drain(core.run("go"))
    const types = sink.events.map((e) => e.type)
    expect(types).toEqual([
      "user_message",
      "turn_started",
      "item_started",
      "item_completed",
      "turn_completed",
      "run_finished",
    ])
    const started = sink.events[1]
    if (started?.type !== "turn_started") throw new Error("expected turn_started")
    expect(started.turn).toBe(1)
    const completed = sink.events[4]
    if (completed?.type !== "turn_completed") throw new Error("expected turn_completed")
    expect(completed.stopReason).toBe("end_turn")
    expect(completed.usage).toEqual({ inputTokens: 5, outputTokens: 2 })
  })

  it("emits a tool_result whose id matches its tool_use item_started id", async () => {
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        return {
          blocks: [{ type: "tool_use" as const, id: "call-xyz", name: "DoThing", input: {} }],
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
    const sink = new CaptureEventSink()
    const core = new AgentCore(
      baseConfig({
        sendFn,
        eventSink: sink,
        toolExecutor: new StubExecutor({ content: "ok", isError: false }),
        toolRegistry: registryOf([{ name: "DoThing", description: "d", input_schema: {} }]),
      }),
    )
    await drain(core.run("do it"))
    const toolStart = sink.events.find(
      (e) => e.type === "item_started" && e.itemType === "tool_use",
    )
    const toolResult = sink.events.find((e) => e.type === "tool_result")
    if (toolStart?.type !== "item_started") throw new Error("no tool_use item_started")
    if (toolResult?.type !== "tool_result") throw new Error("no tool_result")
    // The join key: tool_result.id === the tool_use item_started.id.
    expect(toolResult.id).toBe(toolStart.id)
    expect(toolResult.id).toBe("call-xyz")
    expect(toolResult.name).toBe("DoThing")
    expect(toolResult.isError).toBe(false)
  })

  it("a throwing EventSink never aborts the run (non-throwing contract)", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "still works"
      return {
        blocks: [{ type: "text" as const, text: "still works" }],
        text: "still works",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const throwingSink: EventSink = {
      emit() {
        throw new Error("sink is broken")
      },
    }
    const core = new AgentCore(baseConfig({ sendFn, eventSink: throwingSink }))
    const { text, final } = await drain(core.run("go"))
    // Run completes normally despite every emit() throwing.
    expect(text).toBe("still works")
    expect(final.stopReason).toBe("end_turn")
  })

  it("emits no events when no eventSink is configured (back-compat)", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    // No eventSink: must not throw, must complete.
    const core = new AgentCore(baseConfig({ sendFn }))
    const { text } = await drain(core.run("go"))
    expect(text).toBe("ok")
  })
})

describe("AgentCore.run — realtime deltas (Phase 3)", () => {
  /** Drain a run, discarding the yielded text (events are asserted on the sink). */
  async function drainRun(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<void> {
    while (true) {
      const { done } = await gen.next()
      if (done) return
    }
  }

  it("emitDeltas: emits a text_delta per streamed chunk, in order, concatenating to the text", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "he"
      yield "llo"
      return {
        blocks: [{ type: "text" as const, text: "hello" }],
        text: "hello",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const sink = new CaptureEventSink()
    const core = new AgentCore(baseConfig({ sendFn, eventSink: sink }))
    await drainRun(core.run("go", { emitDeltas: true }))

    const deltas = sink.events.filter((e) => e.type === "text_delta")
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.map((d) => (d.type === "text_delta" ? d.text : "")).join("")).toBe("hello")
    // Every delta of a turn shares the per-turn streaming id.
    for (const d of deltas) if (d.type === "text_delta") expect(d.id).toBe("1:text")
    // The terminal item_completed still carries the whole body.
    const completed = sink.events.find((e) => e.type === "item_completed" && e.itemType === "text")
    if (completed?.type !== "item_completed") throw new Error("no text item_completed")
    expect(completed.text).toBe("hello")
  })

  it("emitDeltas OFF (default): no text_delta events (buffered json + golden parity)", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "he"
      yield "llo"
      return {
        blocks: [{ type: "text" as const, text: "hello" }],
        text: "hello",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const sink = new CaptureEventSink()
    const core = new AgentCore(baseConfig({ sendFn, eventSink: sink }))
    await drainRun(core.run("go"))
    expect(sink.events.some((e) => e.type === "text_delta")).toBe(false)
    // The non-delta event sequence is exactly the Phase-2 shape, plus the
    // additive user_message / run_finished kinds (S18).
    expect(sink.events.map((e) => e.type)).toEqual([
      "user_message",
      "turn_started",
      "item_started",
      "item_completed",
      "turn_completed",
      "run_finished",
    ])
  })

  it("emitDeltas: forwards transport thinking chunks as thinking_delta events", async () => {
    const sendFn = async function* (
      opts: { onThinkingDelta?: (t: string) => void } = {},
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      // Simulate the transport streaming reasoning before the answer.
      opts.onThinkingDelta?.("think ")
      opts.onThinkingDelta?.("more")
      yield "answer"
      return {
        blocks: [{ type: "text" as const, text: "answer" }],
        text: "answer",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const sink = new CaptureEventSink()
    const core = new AgentCore(baseConfig({ sendFn, eventSink: sink }))
    await drainRun(core.run("go", { emitDeltas: true }))

    const thinking = sink.events.filter((e) => e.type === "thinking_delta")
    expect(thinking.map((d) => (d.type === "thinking_delta" ? d.text : "")).join("")).toBe(
      "think more",
    )
    for (const d of thinking) if (d.type === "thinking_delta") expect(d.id).toBe("1:thinking")
    // text_delta and thinking_delta carry distinct per-turn ids.
    const textIds = new Set(
      sink.events.filter((e) => e.type === "text_delta").map((e) => (e as { id: string }).id),
    )
    expect(textIds.has("1:thinking")).toBe(false)
  })

  it("emitDeltas OFF: transport thinking chunks emit no thinking_delta events", async () => {
    const sendFn = async function* (
      opts: { onThinkingDelta?: (t: string) => void } = {},
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      opts.onThinkingDelta?.("secret reasoning")
      yield "answer"
      return {
        blocks: [{ type: "text" as const, text: "answer" }],
        text: "answer",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const sink = new CaptureEventSink()
    const core = new AgentCore(baseConfig({ sendFn, eventSink: sink }))
    await drainRun(core.run("go"))
    expect(sink.events.some((e) => e.type === "thinking_delta")).toBe(false)
  })

  it("emitDeltas: still forwards the caller's own onThinkingDelta callback", async () => {
    const seen: string[] = []
    const sendFn = async function* (
      opts: { onThinkingDelta?: (t: string) => void } = {},
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      opts.onThinkingDelta?.("r1")
      yield "answer"
      return {
        blocks: [{ type: "text" as const, text: "answer" }],
        text: "answer",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const sink = new CaptureEventSink()
    const core = new AgentCore(baseConfig({ sendFn, eventSink: sink }))
    await drainRun(
      core.run("go", {
        emitDeltas: true,
        onThinkingDelta: (c) => {
          seen.push(c)
        },
      }),
    )
    // The wrapper emits the event AND chains to the caller's callback.
    expect(seen).toEqual(["r1"])
    expect(sink.events.some((e) => e.type === "thinking_delta")).toBe(true)
  })
})

describe("AgentCore.run — per-run outputSchema (D1)", () => {
  const RUN_SCHEMA = { type: "object", properties: { answer: { type: "string" } } }
  const SESSION_SCHEMA = { type: "object", properties: { session: { type: "boolean" } } }

  /** Round 1 of each run calls a tool, round 2 ends the turn. Records each request's format. */
  function toolThenEndSend(formats: unknown[], opts?: { failOnSecondRound?: boolean }) {
    let round = 0
    let failNext = opts?.failOnSecondRound ?? false
    return async function* (send: {
      outputConfig?: { format?: unknown }
    }): AsyncGenerator<string, StreamedResponse, undefined> {
      formats.push(send.outputConfig?.format)
      round++
      if (round % 2 === 1) {
        return {
          blocks: [{ type: "tool_use" as const, id: `call-${round}`, name: "DoThing", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      if (failNext) {
        failNext = false
        throw new Error("boom")
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }
  }

  function coreWith(sendFn: unknown, outputSchema?: object): AgentCore {
    return new AgentCore(
      baseConfig({
        sendFn: sendFn as AgentCoreConfig["sendFn"],
        ...(outputSchema ? { outputSchema } : {}),
        toolExecutor: new StubExecutor({ content: "ok", isError: false }),
        toolRegistry: registryOf([{ name: "DoThing", description: "d", input_schema: {} }]),
      }),
    )
  }

  const runFormat = { type: "json_schema", schema: RUN_SCHEMA }
  const sessionFormat = { type: "json_schema", schema: SESSION_SCHEMA }

  it("sends the run schema on every round of that run, and not in the next run", async () => {
    const formats: unknown[] = []
    const core = coreWith(toolThenEndSend(formats))
    await drain(core.run("one", { outputSchema: RUN_SCHEMA }))
    await drain(core.run("two"))
    expect(formats).toEqual([runFormat, runFormat, undefined, undefined])
  })

  it("wins over the session schema for its run, then the session schema comes back", async () => {
    const formats: unknown[] = []
    const core = coreWith(toolThenEndSend(formats), SESSION_SCHEMA)
    await drain(core.run("one", { outputSchema: RUN_SCHEMA }))
    await drain(core.run("two"))
    expect(formats).toEqual([runFormat, runFormat, sessionFormat, sessionFormat])
  })

  it("restores the session schema after a run that fails", async () => {
    const formats: unknown[] = []
    const failing = toolThenEndSend(formats, { failOnSecondRound: true })
    const core = coreWith(failing, SESSION_SCHEMA)
    await expect(drain(core.run("one", { outputSchema: RUN_SCHEMA }))).rejects.toThrow("boom")
    expect(formats).toEqual([runFormat, runFormat])
    await drain(core.run("two"))
    expect(formats).toEqual([runFormat, runFormat, sessionFormat, sessionFormat])
  })

  it("restores the session schema after an aborted run", async () => {
    const formats: unknown[] = []
    const controller = new AbortController()
    let round = 0
    const sendFn = async function* (send: {
      outputConfig?: { format?: unknown }
    }): AsyncGenerator<string, StreamedResponse, undefined> {
      formats.push(send.outputConfig?.format)
      round++
      if (round === 1) {
        controller.abort()
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const core = coreWith(sendFn, SESSION_SCHEMA)
    await expect(
      drain(core.run("one", { outputSchema: RUN_SCHEMA, signal: controller.signal })),
    ).rejects.toThrow()
    await drain(core.run("two"))
    expect(formats).toEqual([runFormat, sessionFormat])
  })

  it("setNextRunOutputSchema arms the next run only", async () => {
    const formats: unknown[] = []
    const core = coreWith(toolThenEndSend(formats))
    core.setNextRunOutputSchema(RUN_SCHEMA)
    await drain(core.run("one"))
    await drain(core.run("two"))
    expect(formats).toEqual([runFormat, runFormat, undefined, undefined])
  })
})

describe("AgentCore.run — per-run temperature (D4)", () => {
  afterEach(() => clearModelRegistry())

  function registerTestModel(id: string, acceptsTemperature: boolean): void {
    registerModel({
      id,
      providerId: "test-provider",
      surfaceId: "test",
      displayName: id,
      capabilities: { ...defaultCapabilities(), acceptsTemperature },
      pricing: {
        inputUSD: 0,
        outputUSD: 0,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
    })
  }

  /** Round 1 of each run calls a tool, round 2 ends the turn. Records each request's temperature. */
  function toolThenEndSend(temps: unknown[], opts?: { failOnSecondRound?: boolean }) {
    let round = 0
    let failNext = opts?.failOnSecondRound ?? false
    return async function* (send: {
      temperature?: number
    }): AsyncGenerator<string, StreamedResponse, undefined> {
      temps.push(send.temperature)
      round++
      if (round % 2 === 1) {
        return {
          blocks: [{ type: "tool_use" as const, id: `call-${round}`, name: "DoThing", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      if (failNext) {
        failNext = false
        throw new Error("boom")
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }
  }

  function coreWith(sendFn: unknown, extra?: Partial<AgentCoreConfig>): AgentCore {
    return new AgentCore(
      baseConfig({
        sendFn: sendFn as AgentCoreConfig["sendFn"],
        toolExecutor: new StubExecutor({ content: "ok", isError: false }),
        toolRegistry: registryOf([{ name: "DoThing", description: "d", input_schema: {} }]),
        ...extra,
      }),
    )
  }

  it("sends the temperature on every round of that run, and not in the next run", async () => {
    const temps: unknown[] = []
    const core = coreWith(toolThenEndSend(temps))
    await drain(core.run("one", { temperature: 0.2 }))
    await drain(core.run("two"))
    expect(temps).toEqual([0.2, 0.2, undefined, undefined])
  })

  it("is gone after a run that fails", async () => {
    const temps: unknown[] = []
    const core = coreWith(toolThenEndSend(temps, { failOnSecondRound: true }))
    await expect(drain(core.run("one", { temperature: 0.7 }))).rejects.toThrow("boom")
    await drain(core.run("two"))
    expect(temps).toEqual([0.7, 0.7, undefined, undefined])
  })

  it("is gone after an aborted run", async () => {
    const temps: unknown[] = []
    const controller = new AbortController()
    let round = 0
    const sendFn = async function* (send: {
      temperature?: number
    }): AsyncGenerator<string, StreamedResponse, undefined> {
      temps.push(send.temperature)
      round++
      if (round === 1) {
        controller.abort()
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const core = coreWith(sendFn)
    await expect(
      drain(core.run("one", { temperature: 0.3, signal: controller.signal })),
    ).rejects.toThrow()
    await drain(core.run("two"))
    expect(temps).toEqual([0.3, undefined])
  })

  it("setNextRunTemperature arms the next run only", async () => {
    const temps: unknown[] = []
    const core = coreWith(toolThenEndSend(temps))
    core.setNextRunTemperature(0.5)
    await drain(core.run("one"))
    await drain(core.run("two"))
    expect(temps).toEqual([0.5, 0.5, undefined, undefined])
  })

  it("sends it to a registered model that accepts temperature, with no diagnostic", async () => {
    registerTestModel("temp-yes", true)
    const temps: unknown[] = []
    const events: LogEvent[] = []
    const diagnostics = createDiagnostics({ emit: (e) => events.push(e) })
    const core = coreWith(toolThenEndSend(temps), { model: "temp-yes", diagnostics })
    await drain(core.run("one", { temperature: 0.4 }))
    expect(temps).toEqual([0.4, 0.4])
    expect(events.filter((e) => e.source === "agent.temperature-ignored")).toEqual([])
  })

  it("drops it for a model with acceptsTemperature false, reports once, and the run succeeds", async () => {
    registerTestModel("temp-no", false)
    const temps: unknown[] = []
    const events: LogEvent[] = []
    const diagnostics = createDiagnostics({ emit: (e) => events.push(e) })
    const core = coreWith(toolThenEndSend(temps), { model: "temp-no", diagnostics })
    const { text } = await drain(core.run("one", { temperature: 0.9 }))
    expect(text).toBe("done")
    expect(temps).toEqual([undefined, undefined])
    const ignored = events.filter((e) => e.source === "agent.temperature-ignored")
    expect(ignored).toHaveLength(1)
    expect(ignored[0]?.severity).toBe(Severity.Warning)
    expect(ignored[0]?.structuredData).toEqual({ model: "temp-no", temperature: 0.9 })
    // A run with no temperature reports nothing.
    await drain(core.run("two"))
    expect(events.filter((e) => e.source === "agent.temperature-ignored")).toHaveLength(1)
  })
})

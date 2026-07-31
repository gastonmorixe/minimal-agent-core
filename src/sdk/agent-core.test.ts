import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import type { AgentEvent, EventSink } from "./events.ts"
import type {
  AgentCoreConfig,
  ToolDefinition,
  ToolExecResult,
  ToolExecutor,
  ToolRegistry,
  TranscriptSink,
} from "./ports.ts"

const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/** Collects every transcript line written by the core. */
class CaptureSink implements TranscriptSink {
  lines: string[] = []
  write(line: string): void {
    this.lines.push(line)
  }
}

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
    transcriptSink: new CaptureSink(),
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
    const sink = new CaptureSink()
    const core = new AgentCore(baseConfig({ sendFn, transcriptSink: sink }))
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

  it("uses the TranscriptSink port for reflection-ack notices", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      const text = '<ma::agent::reflection-ack silence-for="2" reason="batch" />'
      yield text
      return {
        blocks: [{ type: "text" as const, text }],
        text,
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const sink = new CaptureSink()
    const core = new AgentCore(baseConfig({ sendFn, transcriptSink: sink }))
    await drain(core.run("go"))
    const joined = stripAnsi(sink.lines.join("\n"))
    expect(joined).toContain("reflection ack: silencing next")
    expect(joined).toContain("checkpoint")
    expect(joined).toContain("batch")
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
    expect(types).toEqual(["turn_started", "item_started", "item_completed", "turn_completed"])
    const started = sink.events[0]
    if (started?.type !== "turn_started") throw new Error("expected turn_started")
    expect(started.turn).toBe(1)
    const completed = sink.events[3]
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
    // The non-delta event sequence is exactly the Phase-2 shape.
    expect(sink.events.map((e) => e.type)).toEqual([
      "turn_started",
      "item_started",
      "item_completed",
      "turn_completed",
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

  it("emitDeltas: still forwards the caller's own onThinkingChunk callback", async () => {
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
        onThinkingChunk: (c) => {
          seen.push(c)
        },
      }),
    )
    // The wrapper emits the event AND chains to the caller's callback.
    expect(seen).toEqual(["r1"])
    expect(sink.events.some((e) => e.type === "thinking_delta")).toBe(true)
  })
})

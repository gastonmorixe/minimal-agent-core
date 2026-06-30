import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
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

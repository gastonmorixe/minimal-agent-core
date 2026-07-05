/**
 * Unit tests for {@link ToolExecutorAdapter}: the verbatim-executeToolRound
 * binding to the {@link ToolExecutor} port.
 *
 * Focus: (1) plugin-tool dispatch flows through and its content/isError map
 * onto {@link ToolExecResult}; (2) the abort signal is forwarded; (3) the
 * tool_use id is preserved END-TO-END when the adapter is driven by a real
 * {@link AgentCore} (the sacred `tool_result.id === item_started.id` join).
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import type { StreamedResponse } from "../../llm/transport/types.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import { AgentCore } from "../../sdk/agent-core.ts"
import type { AgentEvent, EventSink } from "../../sdk/events.ts"
import { ToolFeedbackTracker } from "../../tools/feedback-tracker.ts"

import { ToolExecutorAdapter } from "./tool-executor-adapter.ts"
import { ToolRegistryAdapter } from "./tool-registry-adapter.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/**
 * A loader stub exposing exactly one plugin tool via `dispatch`, mirroring the
 * in-repo pattern (Wave G deleted on-disk `./plugins`). Records the abort
 * signal it received so the forwarding test can assert on it.
 */
function makeLoaderStub(opts: {
  toolName: string
  content: string
  isError?: boolean
  onDispatch?: (signal?: AbortSignal) => void
}): PluginLoader {
  const stub = {
    hasTool: (name: string) => name === opts.toolName,
    dispatch: async (_trigger: unknown, _cwd: string, signal?: AbortSignal) => {
      opts.onDispatch?.(signal)
      return {
        kind: "tool_result" as const,
        content: opts.content,
        is_error: opts.isError ?? false,
      }
    },
    getExtraTools: () => [
      {
        name: opts.toolName,
        description: "a fixture tool",
        input_schema: { type: "object", properties: {} },
      },
    ],
    getPromptBlockAsync: async () => "",
    getPromptBlock: () => "",
    getToolAliases: () => new Map<string, string>(),
  }
  return stub as unknown as PluginLoader
}

function makeAdapter(loader: PluginLoader | null): ToolExecutorAdapter {
  return new ToolExecutorAdapter({
    presentation: new Map(),
    loader,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    toolTimeTracker: null,
    model: "test-model",
    store: null,
  })
}

describe("ToolExecutorAdapter.execute — plugin tool dispatch", () => {
  it("maps a plugin tool_result's content + is_error onto ToolExecResult", async () => {
    const loader = makeLoaderStub({ toolName: "Widget", content: "widget output" })
    const adapter = makeAdapter(loader)
    const result = await adapter.execute({
      type: "tool_use",
      id: "toolu_abc",
      name: "Widget",
      input: {},
    })
    expect(result.content).toBe("widget output")
    expect(result.isError).toBe(false)
  })

  it("maps an error tool_result to isError:true", async () => {
    const loader = makeLoaderStub({ toolName: "Widget", content: "boom", isError: true })
    const adapter = makeAdapter(loader)
    const result = await adapter.execute({
      type: "tool_use",
      id: "toolu_err",
      name: "Widget",
      input: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content).toBe("boom")
  })

  it("forwards the AbortSignal into plugin dispatch", async () => {
    let seenSignal: AbortSignal | undefined
    const loader = makeLoaderStub({
      toolName: "Widget",
      content: "ok",
      onDispatch: (signal) => {
        seenSignal = signal
      },
    })
    const adapter = makeAdapter(loader)
    const controller = new AbortController()
    await adapter.execute(
      { type: "tool_use", id: "toolu_sig", name: "Widget", input: {} },
      controller.signal,
    )
    expect(seenSignal).toBe(controller.signal)
  })
})

/** Collects every emitted AgentEvent. */
class CaptureEventSink implements EventSink {
  events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

describe("ToolExecutorAdapter — tool_use id passthrough (sacred join)", () => {
  it("preserves tool_result.id === item_started.id through a real AgentCore run", async () => {
    const loader = makeLoaderStub({ toolName: "Widget", content: "done-by-widget" })
    const adapter = makeAdapter(loader)
    const registry = new ToolRegistryAdapter(loader)

    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        return {
          blocks: [{ type: "tool_use" as const, id: "toolu_JOIN_KEY", name: "Widget", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "final"
      return {
        blocks: [{ type: "text" as const, text: "final" }],
        text: "final",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const sink = new CaptureEventSink()
    const core = new AgentCore({
      auth: AUTH,
      model: "test-model",
      systemPrompt: "",
      maxTokens: 0,
      sendFn,
      eventSink: sink,
      toolRegistry: registry,
      toolExecutor: adapter,
      transcriptSink: { write: () => {} },
    })

    // Drain the run.
    const gen = core.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const itemStarted = sink.events.find(
      (e) => e.type === "item_started" && e.itemType === "tool_use",
    )
    const toolResult = sink.events.find((e) => e.type === "tool_result")
    if (itemStarted?.type !== "item_started") throw new Error("no tool_use item_started")
    if (toolResult?.type !== "tool_result") throw new Error("no tool_result")
    // The join key must survive the adapter untouched.
    expect(toolResult.id).toBe(itemStarted.id)
    expect(toolResult.id).toBe("toolu_JOIN_KEY")
    expect(toolResult.name).toBe("Widget")
    expect(toolResult.isError).toBe(false)
  })
})

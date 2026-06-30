/**
 * End-to-end wire-format test for the AgentCore → JsonlEventSink event stream:
 * AgentCore emits AgentEvents through a real {@link JsonlEventSink}, and we
 * assert the EXACT JSONL bytes it produces.
 *
 * SCOPE (honest, per the P4 ruling): this is the Codex-style turn/item/tool
 * EVENT stream. It is NOT yet what the live CLI `--json` flag emits — the
 * non-interactive CLI path currently drives the legacy Agent and `--json`
 * ships the "final answer as one JSONL line," not this event stream. Wiring
 * AgentCore + this JsonlEventSink into the CLI's non-interactive path is
 * PHASE 5 (owner: Dorothy). This test pins the event-stream contract NOW so
 * that Phase 5 swap lands against a frozen, proven wire format instead of an
 * unverified one. "Built, not yet shipped" — and tested either way.
 *
 * The unit tests elsewhere check the pieces in isolation:
 *   - agent-core.test.ts asserts the emitted event OBJECTS (Dorothy's seams).
 *   - events.test.ts asserts serializeEvent() on hand-built events (Betty).
 *
 * This test composes them: it drives a full AgentCore.run() through the
 * JsonlEventSink, captures the serialized lines, and golden-asserts the
 * stream. A field rename, an emit-order change, or a serialization regression
 * anywhere in AgentCore → events.ts breaks it here.
 *
 * @module sdk/events-jsonl.integration.test
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import { JsonlEventSink } from "./events.ts"
import type {
  AgentCoreConfig,
  ToolDefinition,
  ToolExecResult,
  ToolExecutor,
  ToolRegistry,
  TranscriptSink,
} from "./ports.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

class CaptureSink implements TranscriptSink {
  lines: string[] = []
  write(line: string): void {
    this.lines.push(line)
  }
}

const EMPTY_REGISTRY: ToolRegistry = { list: () => [] }

function registryOf(tools: ToolDefinition[]): ToolRegistry {
  return { list: () => tools }
}

class StubExecutor implements ToolExecutor {
  constructor(private readonly result: ToolExecResult) {}
  async execute(_toolUse: { name: string }): Promise<ToolExecResult> {
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

async function drain(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<void> {
  while (true) {
    const { done } = await gen.next()
    if (done) return
  }
}

/** Concatenate the captured JSONL lines and parse each back to an object. */
function parseStream(raw: string): unknown[] {
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

describe("AgentCore → JsonlEventSink wire format (--json end-to-end)", () => {
  it("serializes a text-only turn to the exact JSONL stream", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "hi"
      return {
        blocks: [{ type: "text" as const, text: "hi" }],
        text: "hi",
        stopReason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      } as StreamedResponse
    }
    // The exact sink the host uses for --json: serialize each event to a line.
    const out: string[] = []
    const sink = new JsonlEventSink((line) => out.push(line))
    const core = new AgentCore(baseConfig({ sendFn, eventSink: sink }))
    await drain(core.run("go"))

    const raw = out.join("")
    // Every emitted line is exactly one JSON object terminated by one newline.
    expect(out.every((l) => l.endsWith("\n"))).toBe(true)
    expect(out.every((l) => l.split("\n").length === 2)).toBe(true)

    const events = parseStream(raw)
    expect(events).toEqual([
      { type: "turn_started", turn: 1 },
      { type: "item_started", itemType: "text", id: "1:0" },
      { type: "item_completed", itemType: "text", id: "1:0", text: "hi" },
      {
        type: "turn_completed",
        turn: 1,
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    ])
  })

  it("preserves the tool-call → tool-result id join across serialization", async () => {
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
    const out: string[] = []
    const sink = new JsonlEventSink((line) => out.push(line))
    const core = new AgentCore(
      baseConfig({
        sendFn,
        eventSink: sink,
        toolExecutor: new StubExecutor({ content: "ok", isError: false }),
        toolRegistry: registryOf([{ name: "DoThing", description: "d", input_schema: {} }]),
      }),
    )
    await drain(core.run("do it"))

    const events = parseStream(out.join("")) as Array<Record<string, unknown>>

    // The whole stream survived JSON.parse: every line was valid JSON.
    expect(events.length).toBeGreaterThan(0)

    // After serialization + reparse, the tool_use item and the tool_result
    // still share the same `id` — the join key a --json consumer relies on.
    const toolStart = events.find((e) => e.type === "item_started" && e.itemType === "tool_use")
    const toolResult = events.find((e) => e.type === "tool_result")
    expect(toolStart).toBeDefined()
    expect(toolResult).toBeDefined()
    expect(toolResult?.id).toBe("call-xyz")
    expect(toolResult?.id).toBe(toolStart?.id)
    expect(toolResult?.name).toBe("DoThing")
    expect(toolResult?.isError).toBe(false)

    // Two turns ran (tool round + final), so two turn_started lines on the wire.
    expect(events.filter((e) => e.type === "turn_started")).toHaveLength(2)
    const last = events.at(-1)
    expect(last?.type).toBe("turn_completed")
    expect(last?.stopReason).toBe("end_turn")
  })

  it("emits a single concatenated valid JSONL document (no partial lines)", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "x"
      return {
        blocks: [{ type: "text" as const, text: "x" }],
        text: "x",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const out: string[] = []
    const sink = new JsonlEventSink((line) => out.push(line))
    const core = new AgentCore(baseConfig({ sendFn, eventSink: sink }))
    await drain(core.run("go"))

    const raw = out.join("")
    // The document ends with a newline and every line parses — the property a
    // downstream `jq -c` / line reader depends on.
    expect(raw.endsWith("\n")).toBe(true)
    const lineCount = raw.split("\n").filter((l) => l.length > 0).length
    expect(parseStream(raw)).toHaveLength(lineCount)
  })
})

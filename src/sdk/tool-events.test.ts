/**
 * Tool facts in events (spec S19), through a real `AgentCore.run` with a
 * fake tool: `item_started` declares `toolName`, `tool_result` adds
 * `inputSummary` / `outputSummary` / `durationMs`, and `tool_call` /
 * `tool_output` (opt-in) carry the full input / output.
 *
 * @module sdk/tool-events.test
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { RetryClock } from "../llm/transport/retry-policy.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import type { AgentEvent, AgentEventType } from "./events.ts"
import { ALL_EVENT_KINDS } from "./events.ts"
import type { ToolExecResult } from "./ports.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const STILL_CLOCK: RetryClock = { now: () => 5_000, sleep: async () => {} }

function toolTurnSend() {
  let round = 0
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round === 1) {
      return {
        blocks: [
          {
            type: "tool_use" as const,
            id: "call-1",
            name: "WebFetch",
            input: { url: "https://example.com", method: "GET" },
          },
        ],
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

function coreWith(result: ToolExecResult, events: AgentEvent[]): AgentCore {
  return new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: {
      list: () => [{ name: "WebFetch", description: "fetch", input_schema: {} }],
    },
    toolExecutor: { execute: async () => result },
    transcriptSink: { write: () => {} },
    sendFn: toolTurnSend(),
    eventSink: { emit: (e) => events.push(e), kinds: ALL_EVENT_KINDS },
    retry: { clock: STILL_CLOCK },
  })
}

async function drainRun(core: AgentCore): Promise<void> {
  const gen = core.run("fetch it")
  while (!(await gen.next()).done) {
    // drain
  }
}

describe("tool facts in events (S19)", () => {
  it("item_started declares toolName on a tool_use item", async () => {
    const events: AgentEvent[] = []
    await drainRun(coreWith({ content: "ok", isError: false }, events))
    const started = events.find((e) => e.type === "item_started" && e.itemType === "tool_use")
    if (started?.type !== "item_started") throw new Error("expected item_started")
    expect(started.toolName).toBe("WebFetch")
    expect(started.label).toBe("WebFetch")
  })

  it("tool_result adds inputSummary, outputSummary, and durationMs", async () => {
    const events: AgentEvent[] = []
    await drainRun(coreWith({ content: "line one\nline two", isError: false }, events))
    const result = events.find((e) => e.type === "tool_result")
    if (result?.type !== "tool_result") throw new Error("expected tool_result")
    expect(result.name).toBe("WebFetch")
    expect(result.isError).toBe(false)
    // S29: core no longer has a per-tool header field to prefer, so the
    // input summary is always the compact JSON of the call.
    expect(result.inputSummary).toBe('{"url":"https://example.com","method":"GET"}')
    expect(result.outputSummary).toBe("line one (+1 line)")
    expect(result.durationMs).toBe(0)
  })

  it("tool_call carries the input and inputSummary (unconditional once a sink lists it)", async () => {
    const events: AgentEvent[] = []
    await drainRun(coreWith({ content: "ok", isError: false }, events))
    const call = events.find((e) => e.type === "tool_call")
    expect(call).toEqual({
      type: "tool_call",
      callId: "call-1",
      toolName: "WebFetch",
      input: { url: "https://example.com", method: "GET" },
      inputSummary: '{"url":"https://example.com","method":"GET"}',
    })
  })

  it("tool_output is opt-in: present for a sink that lists it, absent otherwise", async () => {
    const withKinds: AgentEvent[] = []
    await drainRun(coreWith({ content: "the body", isError: false }, withKinds))
    const out = withKinds.find((e) => e.type === "tool_output")
    expect(out).toEqual({
      type: "tool_output",
      callId: "call-1",
      toolName: "WebFetch",
      text: "the body",
      truncated: false,
      totalBytes: 8,
    })

    const noKinds: AgentEvent[] = []
    const core = new AgentCore({
      auth: AUTH,
      model: "test-model",
      systemPrompt: "",
      maxTokens: 4096,
      toolRegistry: { list: () => [{ name: "WebFetch", description: "fetch", input_schema: {} }] },
      toolExecutor: { execute: async () => ({ content: "the body", isError: false }) },
      transcriptSink: { write: () => {} },
      sendFn: toolTurnSend(),
      // Default kinds (unset): every kind except tool_output.
      eventSink: { emit: (e) => noKinds.push(e) },
      retry: { clock: STILL_CLOCK },
    })
    await drainRun(core)
    const types: AgentEventType[] = noKinds.map((e) => e.type)
    expect(types).toContain("tool_result")
    expect(types).not.toContain("tool_output")
  })
})

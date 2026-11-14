/**
 * S0.5 claim (a), reshaped by S14.4: a retry after streamed text emits a typed
 * `retry-boundary` event. Core holds no marker text. The marker never enters
 * `response.blocks`, history, the yielded strings, or any `text_delta`.
 *
 * @module sdk/s05-claim-a-retry-stall-marker.test
 */
import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { RetryClock } from "../llm/transport/retry-policy.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import type { AgentEvent } from "./events.ts"
import type { AgentCoreConfig } from "./ports.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const CLOCK: RetryClock = { now: () => 0, sleep: async () => {} }

function config(overrides: Partial<AgentCoreConfig>): AgentCoreConfig {
  return {
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    retry: { clock: CLOCK, random: () => 0 },
    ...overrides,
  }
}

describe("S14.4: retry-boundary event, no marker text in core", () => {
  it("emits retry-boundary (attempt 2), no marker text anywhere, nothing in blocks or history", async () => {
    let calls = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      calls++
      if (calls === 1) {
        yield "partial"
        throw Object.assign(new Error("stall"), { errorClass: "transient" })
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const events: AgentEvent[] = []
    const core = new AgentCore(
      config({ sendFn, eventSink: { emit: (ev: AgentEvent) => void events.push(ev) } }),
    )
    const gen = core.run("hi", { emitDeltas: true })
    let text = ""
    let final: StreamedResponse
    while (true) {
      const r = await gen.next()
      if (r.done) {
        final = r.value
        break
      }
      text += r.value
    }
    expect(calls).toBe(2)
    const boundaries = events.filter((e) => e.type === "retry-boundary")
    expect(boundaries).toEqual([{ type: "retry-boundary", id: "1:text", attempt: 2 }])
    // No marker text on the string channel or in any text_delta.
    expect(text).toBe("partialdone")
    const deltas = events.filter((e) => e.type === "text_delta") as { text: string }[]
    expect(deltas.map((d) => d.text)).toEqual(["partial", "done"])
    // Never in the stored response or history.
    expect(JSON.stringify(final.blocks)).not.toContain("stalled")
    expect(JSON.stringify(core.history())).not.toContain("stalled")
    expect(final.blocks).toEqual([{ type: "text", text: "done" }])
  })

  it("emits no retry-boundary when the run does not opt in to deltas", async () => {
    let calls = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      calls++
      if (calls === 1) {
        yield "partial"
        throw Object.assign(new Error("stall"), { errorClass: "transient" })
      }
      return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
    }
    const events: AgentEvent[] = []
    const core = new AgentCore(
      config({ sendFn, eventSink: { emit: (ev: AgentEvent) => void events.push(ev) } }),
    )
    const gen = core.run("hi")
    while (!(await gen.next()).done) {}
    expect(events.some((e) => e.type === "retry-boundary")).toBe(false)
  })
})

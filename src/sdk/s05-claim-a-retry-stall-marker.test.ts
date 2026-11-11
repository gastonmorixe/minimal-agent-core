/**
 * S0.5 claim (a): `retryStallMarker` text reaches the caller (yield and
 * `text_delta`) but never enters `response.blocks` or history.
 *
 * @module sdk/s05-claim-a-retry-stall-marker.test
 */
import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { retryStallMarker } from "../llm/transport/retry.ts"
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

describe("S0.5 claim a: retryStallMarker stays out of response.blocks", () => {
  it("marker is yielded and emitted as text_delta, but not stored in blocks or history", async () => {
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
    const marker = retryStallMarker(2)
    expect(calls).toBe(2)
    // The marker is on the text channel.
    expect(text).toContain(marker)
    const deltas = events.filter((e) => e.type === "text_delta") as { text: string }[]
    expect(deltas.some((d) => d.text === marker)).toBe(true)
    // But never in the stored response or history.
    expect(JSON.stringify(final.blocks)).not.toContain("stalled")
    expect(JSON.stringify(core.history())).not.toContain("stalled")
    expect(final.blocks).toEqual([{ type: "text", text: "done" }])
  })
})

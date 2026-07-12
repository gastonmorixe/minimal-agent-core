/**
 * Agent-loop continuation after terminal-less stream salvage.
 *
 * Transport returns stopReason tool_use + stopDetails.stream_closed_without_terminal
 * with only complete tool blocks. The loop must:
 *   - execute the complete tool once
 *   - inject stream-interrupted attachment on the tool_result user turn
 *   - make a NEW sendFn call (continuation) with updated local state
 *   - never re-issue the interrupted request body (proven by distinct send rounds)
 *
 * @module agent/agent.stream-interrupted.test
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../client/types.ts"
import type { Message } from "../llm/messages.ts"

import { Agent } from "./agent.ts"
import type { TurnNotice } from "./turn-notice.ts"

const auth: AuthResult = { type: "api-key", token: "test-token" }

async function drainRun(
  agent: Agent,
  prompt: string,
  hooks?: { onNotice?: (n: TurnNotice) => void },
): Promise<string[]> {
  const transcript: string[] = []
  const gen = agent.run(prompt, {
    onTranscriptLine: (line) => transcript.push(line),
    ...(hooks?.onNotice ? { onNotice: hooks.onNotice } : {}),
  })
  while (true) {
    const { done } = await gen.next()
    if (done) break
  }
  return transcript
}

describe("Agent.run stream_interrupted salvage continuation", () => {
  it("executes complete tool once, continues with new request, never replays interrupted body", async () => {
    const requestBodies: Message[][] = []
    let round = 0
    const notices: TurnNotice[] = []

    const sendFn = async function* (opts: {
      messages: Message[]
    }): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      // Deep-ish snapshot of the messages the transport would send.
      requestBodies.push(JSON.parse(JSON.stringify(opts.messages)) as Message[])

      if (round === 1) {
        // What the bridge returns after terminal-less EOF: ONLY the complete
        // tool. An incomplete second tool must already have been discarded
        // upstream (see adapter-legacy-salvage tests) and must not appear.
        return {
          blocks: [
            {
              type: "tool_use",
              id: "tu_complete",
              name: "Bash",
              input: { command: "echo hi" },
            },
          ],
          text: "",
          stopReason: "tool_use",
          stopDetails: {
            type: "stream_closed_without_terminal",
            message: "salvaged",
          },
        } as StreamedResponse
      }

      // Continuation after tool_result — clean finish.
      yield "done after tools"
      return {
        blocks: [{ type: "text" as const, text: "done after tools" }],
        text: "done after tools",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const agent = new Agent({ auth, model: "test-model", sendFn: sendFn as never })
    await drainRun(agent, "run a command", {
      onNotice: (n) => notices.push(n),
    })

    expect(round).toBe(2)
    // Two distinct request bodies — not a byte-identical replay of round 1.
    expect(requestBodies).toHaveLength(2)
    const body1 = JSON.stringify(requestBodies[0])
    const body2 = JSON.stringify(requestBodies[1])
    expect(body1).not.toBe(body2)

    // History: exactly one tool_use for the complete id, never a partial id.
    const history = JSON.stringify(agent.messages)
    expect(history).toContain("tu_complete")
    expect(history).not.toContain("tu_partial")
    expect(history).not.toContain("call_partial")
    const toolUseCount = (history.match(/"type":"tool_use"/g) ?? []).length
    const toolResultCount = (history.match(/"type":"tool_result"/g) ?? []).length
    expect(toolUseCount).toBe(1)
    expect(toolResultCount).toBe(1)

    // Continuation request carries tool_result + stream-interrupted notice text.
    expect(body2).toContain("tu_complete")
    expect(body2).toContain("tool_result")
    expect(body2).toContain("stream-interrupted")
    // Incomplete second tool must never appear in the continuation body either.
    expect(body2).not.toContain("tu_partial")

    // Notice fired with completedToolCalls === 1.
    expect(notices.some((n) => n.kind === "stream_interrupted_salvaged")).toBe(true)
    const salvage = notices.find((n) => n.kind === "stream_interrupted_salvaged")
    expect(
      salvage && salvage.kind === "stream_interrupted_salvaged" && salvage.completedToolCalls,
    ).toBe(1)
  })

  it("mid-text terminal-less continues once with new body, preserves partial text", async () => {
    const requestBodies: Message[][] = []
    let round = 0
    const notices: TurnNotice[] = []

    const sendFn = async function* (opts: {
      messages: Message[]
    }): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      requestBodies.push(JSON.parse(JSON.stringify(opts.messages)) as Message[])

      if (round === 1) {
        yield "Continuing: writing the plan"
        return {
          blocks: [{ type: "text" as const, text: "Continuing: writing the plan" }],
          text: "Continuing: writing the plan",
          stopReason: "end_turn",
          stopDetails: {
            type: "stream_closed_without_terminal",
            message: "partial text salvage",
          },
        } as StreamedResponse
      }

      yield " and delivering via Intercom."
      return {
        blocks: [{ type: "text" as const, text: " and delivering via Intercom." }],
        text: " and delivering via Intercom.",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const agent = new Agent({ auth, model: "test-model", sendFn: sendFn as never })
    await drainRun(agent, "continue", {
      onNotice: (n) => notices.push(n),
    })

    expect(round).toBe(2)
    expect(requestBodies).toHaveLength(2)
    const body1 = JSON.stringify(requestBodies[0])
    const body2 = JSON.stringify(requestBodies[1])
    expect(body1).not.toBe(body2)

    // Round-2 body carries partial assistant text + continue attachment.
    expect(body2).toContain("Continuing: writing the plan")
    expect(body2).toContain("stream-interrupted")

    expect(notices.some((n) => n.kind === "stream_interrupted_continuing")).toBe(true)
    const cont = notices.find((n) => n.kind === "stream_interrupted_continuing")
    expect(cont && cont.kind === "stream_interrupted_continuing" && cont.attempt).toBe(1)
    expect(cont && cont.kind === "stream_interrupted_continuing" && cont.cap).toBe(1)

    // Partial text is in agent history.
    expect(JSON.stringify(agent.messages)).toContain("Continuing: writing the plan")
  })

  it("two consecutive mid-text terminal-less closes hit continuation cap", async () => {
    let round = 0
    const notices: TurnNotice[] = []

    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      yield `partial ${round}`
      return {
        blocks: [{ type: "text" as const, text: `partial ${round}` }],
        text: `partial ${round}`,
        stopReason: "end_turn",
        stopDetails: {
          type: "stream_closed_without_terminal",
          message: "again",
        },
      } as StreamedResponse
    }

    const agent = new Agent({ auth, model: "test-model", sendFn: sendFn as never })
    await drainRun(agent, "continue", {
      onNotice: (n) => notices.push(n),
    })

    // First mid-text → continue (round 2). Second mid-text → capped, stop.
    expect(round).toBe(2)
    expect(notices.some((n) => n.kind === "stream_interrupted_continuing")).toBe(true)
    expect(notices.some((n) => n.kind === "stream_interrupted_capped")).toBe(true)
  })
})

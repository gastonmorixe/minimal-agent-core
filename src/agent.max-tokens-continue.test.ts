/**
 * Coverage for the agentic loop's `max_tokens` handling (Fix B + D).
 *
 * Before this, the loop branched only on "are there tool_use blocks?" and
 * never inspected `stopReason`. A response truncated at the output ceiling
 * came back with no actionable tool block, so the loop treated a
 * budget-capped turn as a clean `end_turn` and exited — the turn died
 * silently and the user had to re-prompt ("go"). The observed incident:
 * session 772d06b8 on 2026-05-31.
 *
 * Now the loop:
 *   - auto-continues when a response hits max_tokens with no tool block,
 *   - bounds that with MAX_TOKENS_CONTINUATION_CAP so a turn that truncates
 *     every time can't loop forever,
 *   - resets the streak whenever real progress happens (a tool ran, or a
 *     clean turn finished),
 *   - surfaces a visible transcript note each time (Fix D).
 */

import { describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth/auth.ts"
import type { StreamedResponse } from "./client/types.ts"

const auth: AuthResult = { type: "api-key", token: "test-token" }

async function drainRun(agent: Agent, prompt: string): Promise<string[]> {
  const transcript: string[] = []
  const gen = agent.run(prompt, { onTranscriptLine: (line) => transcript.push(line) })
  while (true) {
    const { done } = await gen.next()
    if (done) break
  }
  return transcript
}

describe("Agent.run max_tokens auto-continue", () => {
  it("auto-continues when a response truncates with no tool block, then finishes", async () => {
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        // Truncated mid-text: a text block but stopReason max_tokens.
        yield "partial"
        return {
          blocks: [{ type: "text" as const, text: "partial answer that ran out of budg" }],
          text: "partial answer that ran out of budg",
          stopReason: "max_tokens",
        } as StreamedResponse
      }
      yield "rest"
      return {
        blocks: [{ type: "text" as const, text: "...et and now the rest." }],
        text: "...et and now the rest.",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const agent = new Agent({ auth, model: "test-model", sendFn })
    const transcript = await drainRun(agent, "write a long thing")

    // It made a second request (recovered) rather than dying after round 1.
    expect(round).toBe(2)
    const joined = transcript.join("\n")
    expect(joined.toLowerCase()).toContain("max_tokens")
    expect(joined).toContain("auto-continuing (1/")
    // The continuation nudge was injected as a user turn.
    const msgs = agent.messages
    const hasNudge = msgs.some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "text" && b.text.includes("ma::agent::output-truncated")),
    )
    expect(hasNudge).toBe(true)
  })

  it("salvaged tool_use at max_tokens executes and the loop continues (streak stays 0)", async () => {
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        // A tool_use that was salvaged from a max_tokens-truncated stream:
        // stopReason is max_tokens but there IS a complete tool block.
        return {
          blocks: [{ type: "tool_use" as const, id: "call-1", name: "NonExistentTool", input: {} }],
          text: "",
          stopReason: "max_tokens",
        } as StreamedResponse
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const agent = new Agent({ auth, model: "test-model", sendFn })
    const transcript = await drainRun(agent, "go")

    expect(round).toBe(2)
    const joined = transcript.join("\n")
    // Salvage-path note, NOT the auto-continue note.
    expect(joined).toContain("salvaged the in-flight call")
    expect(joined).not.toContain("auto-continuing")
    // The (unknown) tool still got dispatched, producing a tool_result turn.
    expect(joined).toContain("NonExistentTool")
  })

  it("stops after MAX_TOKENS_CONTINUATION_CAP consecutive truncations", async () => {
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      // Always truncate, never make progress.
      yield "x"
      return {
        blocks: [{ type: "text" as const, text: `chunk ${round}` }],
        text: `chunk ${round}`,
        stopReason: "max_tokens",
      } as StreamedResponse
    }

    const agent = new Agent({ auth, model: "test-model", sendFn })
    const transcript = await drainRun(agent, "loop forever")

    // Cap is 5: rounds 1..5 each auto-continue, round 6 trips the cap and
    // stops. So sendFn is called exactly 6 times, not infinitely.
    expect(round).toBe(6)
    const joined = transcript.join("\n")
    expect(joined).toContain("5 times in a row")
    expect(joined.toLowerCase()).toContain("stopping")
  })

  it("resets the streak when a clean turn happens between truncations", async () => {
    // Pattern: truncate, truncate, clean, truncate ... ×5, then cap.
    // If the streak did NOT reset on the clean turn, the cap would trip
    // sooner. We assert the clean turn in the middle pushes the cap later.
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      // round 3 is a clean end_turn (resets streak); all others truncate.
      if (round === 3) {
        // A clean turn with no tool ends the run normally — so to keep the
        // run alive we make round 3 a tool call instead (real progress that
        // resets the streak and continues the loop).
        return {
          blocks: [{ type: "tool_use" as const, id: "t3", name: "NonExistentTool", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "x"
      return {
        blocks: [{ type: "text" as const, text: `chunk ${round}` }],
        text: `chunk ${round}`,
        stopReason: "max_tokens",
      } as StreamedResponse
    }

    const agent = new Agent({ auth, model: "test-model", sendFn })
    const transcript = await drainRun(agent, "mixed")

    // rounds: 1 trunc(1), 2 trunc(2), 3 tool(reset→0), 4 trunc(1), 5 trunc(2),
    // 6 trunc(3), 7 trunc(4), 8 trunc(5), 9 trunc → cap trips. = 9 calls.
    // (Without the reset it would have tripped at round 7.)
    expect(round).toBe(9)
    const joined = transcript.join("\n")
    expect(joined).toContain("5 times in a row")
  })
})

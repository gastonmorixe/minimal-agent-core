/**
 * Coverage for the agentic loop's `max_tokens` handling (Fix B + D).
 *
 * Before this, the loop branched only on "are there tool_use blocks?" and
 * never inspected `stopReason`. A response truncated at the output ceiling
 * came back with no actionable tool block, so the loop treated a
 * budget-capped turn as a clean `end_turn` and exited — the turn died
 * silently and the user had to re-prompt ("go"). The observed incident:
 * session d51e3955 on 2026-05-31.
 *
 * Now the loop:
 *   - auto-continues when a response hits max_tokens with no tool block,
 *   - bounds that with MAX_TOKENS_CONTINUATION_CAP so a turn that truncates
 *     every time can't loop forever,
 *   - resets the streak whenever real progress happens (a tool call
 *     succeeded, or a clean turn finished),
 *   - surfaces a visible transcript note each time (Fix D).
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../client/types.ts"
import type { TransportFn } from "../llm/transport/types.ts"
import type { AgentCore } from "../sdk/agent-core.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

import type { TurnNotice } from "./turn-notice.ts"

/** A typed test line for a notice: its kind and its JSON fields. */
function noticeLine(n: TurnNotice): string {
  return `notice ${n.kind} ${JSON.stringify(n)}`
}

const auth: AuthResult = { type: "api-key", token: "test-token" }

/**
 * Build an AgentCore whose notice lines and tool starts record into the
 * returned array. Turn notices are `notice` events. The sink adds each one as the plain line a
 * text host prints.
 */
async function buildAgent(
  sendFn: TransportFn,
): Promise<{ agent: AgentCore; transcript: string[] }> {
  const transcript: string[] = []
  const agent = await buildTestCore({
    auth,
    sendFn,
    // A tool call adds its name, so a test can see that it ran.
    toolView: {
      onToolEvent: (e) => {
        if (e.type === "started") transcript.push(`tool ${e.tool.name}`)
      },
    },
    eventSink: {
      emit: (e) => {
        if (e.type === "notice") transcript.push(`\n  ${noticeLine(e.notice)}`)
      },
    },
  })
  return { agent, transcript }
}

async function drainRun(agent: AgentCore, prompt: string): Promise<void> {
  const gen = agent.run(prompt)
  while (true) {
    const { done } = await gen.next()
    if (done) break
  }
}

describe("AgentCore.run max_tokens auto-continue", () => {
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

    const { agent, transcript } = await buildAgent(sendFn)
    await drainRun(agent, "write a long thing")

    // It made a second request (recovered) rather than dying after round 1.
    expect(round).toBe(2)
    const joined = transcript.join("\n")
    expect(joined).toContain("notice max_tokens_continuing")
    expect(joined).toContain('"attempt":1')
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

    const { agent, transcript } = await buildAgent(sendFn)
    await drainRun(agent, "go")

    expect(round).toBe(2)
    const joined = transcript.join("\n")
    // Salvage-path note, NOT the auto-continue note.
    expect(joined).toContain("notice max_tokens_salvaged")
    expect(joined).not.toContain("max_tokens_continuing")
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

    const { agent, transcript } = await buildAgent(sendFn)
    await drainRun(agent, "loop forever")

    // Cap is 5: rounds 1..5 each auto-continue, round 6 trips the cap and
    // stops. So sendFn is called exactly 6 times, not infinitely.
    expect(round).toBe(6)
    const joined = transcript.join("\n")
    expect(joined).toContain("notice max_tokens_capped")
    expect(joined).toContain('"cap":5')
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
        // run alive we make round 3 a successful tool call instead (real
        // progress that resets the streak and continues the loop, stop-table
        // row 2).
        return {
          blocks: [
            { type: "tool_use" as const, id: "t3", name: "Bash", input: { command: "true" } },
          ],
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

    const { agent, transcript } = await buildAgent(sendFn)
    await drainRun(agent, "mixed")

    // rounds: 1 trunc(1), 2 trunc(2), 3 tool(reset→0), 4 trunc(1), 5 trunc(2),
    // 6 trunc(3), 7 trunc(4), 8 trunc(5), 9 trunc → cap trips. = 9 calls.
    // (Without the reset it would have tripped at round 7.)
    expect(round).toBe(9)
    const joined = transcript.join("\n")
    expect(joined).toContain("notice max_tokens_capped")
  })

  it("does not reset the streak on a tool call that fails", async () => {
    // Row 2 resets the streak only after one SUCCESSFUL tool call. A failed
    // call (unknown tool) is not progress, so the guard trips sooner.
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 3) {
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

    const { agent, transcript } = await buildAgent(sendFn)
    await drainRun(agent, "mixed")

    // rounds: 1 trunc(1), 2 trunc(2), 3 failed tool (no reset), 4 trunc(3),
    // 5 trunc(4), 6 trunc(5), 7 trunc → cap trips. = 7 calls.
    expect(round).toBe(7)
    expect(transcript.join("\n")).toContain("notice max_tokens_capped")
  })
})

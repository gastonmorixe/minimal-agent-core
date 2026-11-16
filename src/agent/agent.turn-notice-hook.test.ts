import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { SendOptions, StreamedResponse } from "../client/types.ts"
import type { EventSink } from "../sdk/events.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

import { detectStopNotice, type TurnNotice } from "./turn-notice.ts"

/**
 * TurnNotice seam (CORE side). Out-of-band conditions the agent loop
 * surfaces (provider refusal / content filter, output-budget events,
 * reflection-ack confirmations) used to be ANSI-styled `writeTranscript`
 * calls inside the core loop. Now each one is a `notice` event that carries
 * a semantic {@link TurnNotice} value (S37). Contract, pinned here across
 * the two CORE layers:
 *
 *   1. `detectStopNotice` (core, pure): stop reason + details →
 *      StopNotice | null. No ANSI, no I/O.
 *   2. `AgentCore.run` dispatch: emits one `notice` event per notice, and
 *      writes no transcript line. The host renders it.
 *
 * The HOST renderer (`renderTurnNotice`) is pinned separately in
 * `minimal-agent-cli/src/ui/turn-notice.test.ts` : a core test file must not import
 * the host tree (the core→host import ratchet), so the presentation
 * assertions live host-side where such imports are blessed.
 */

const auth: AuthResult = { type: "api-key", token: "test-token" }

function makeSendFn(response: Partial<StreamedResponse>, rounds?: Partial<StreamedResponse>[]) {
  let call = 0
  return async function* (_opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    const r = rounds ? (rounds[call] ?? rounds[rounds.length - 1]) : response
    call++
    yield r.text ?? ""
    return {
      blocks: r.blocks ?? (r.text ? [{ type: "text", text: r.text }] : []),
      text: r.text ?? "",
      stopReason: r.stopReason ?? null,
      stopDetails: r.stopDetails,
    } as StreamedResponse
  }
}

/** An event sink that keeps only the `notice` payloads. */
function noticeSink(notices: TurnNotice[]): EventSink {
  return {
    emit: (e) => {
      if (e.type === "notice") notices.push(e.notice)
    },
  }
}

async function runAgent(
  response: Partial<StreamedResponse>,
): Promise<{ lines: string[]; notices: TurnNotice[] }> {
  const lines: string[] = []
  const notices: TurnNotice[] = []
  const agent = await buildTestCore({
    auth,
    sendFn: makeSendFn(response),
    // The tool view port is the only other host sink. A notice never
    // goes there.
    toolView: { onToolEvent: (e) => void lines.push(JSON.stringify(e)) },
    eventSink: noticeSink(notices),
  })
  const gen = agent.run("hi")
  while (true) {
    const { done } = await gen.next()
    if (done) break
  }
  return { lines, notices }
}

describe("detectStopNotice (pure core projection)", () => {
  it("maps refusal with details to a notice", () => {
    const n = detectStopNotice("refusal", { type: "policy_violation", message: "flagged" })
    expect(n).toEqual({
      kind: "refusal",
      severity: "error",
      category: "policy_violation",
      message: "flagged",
    })
  })

  it("suppresses a category that merely repeats the stop reason", () => {
    expect(detectStopNotice("refusal", { type: "refusal" })).toEqual({
      kind: "refusal",
      severity: "error",
      category: null,
      message: null,
    })
  })

  it("maps content_filter without details", () => {
    expect(detectStopNotice("content_filter", null)).toEqual({
      kind: "content_filter",
      severity: "error",
      category: null,
      message: null,
    })
  })

  it("returns null for every normal termination (incl. max_tokens: loop handles it)", () => {
    for (const reason of ["end_turn", "tool_use", "max_tokens", "pause_turn", null]) {
      expect(detectStopNotice(reason)).toBeNull()
    }
  })
})

describe("AgentCore.run notice events (refusal path)", () => {
  it("emits the semantic notice as an event and writes no tool view line", async () => {
    const { lines, notices } = await runAgent({
      stopReason: "refusal",
      stopDetails: { type: "refusal" },
    })
    expect(notices).toEqual([{ kind: "refusal", severity: "error", category: null, message: null }])
    expect(lines.find((l) => l.includes("safety layer"))).toBeUndefined()
  })

  it("carries the category and message as typed fields, with no text", async () => {
    const { notices } = await runAgent({
      stopReason: "refusal",
      stopDetails: { type: "policy_violation", message: "flagged" },
    })
    expect(notices).toEqual([
      { kind: "refusal", severity: "error", category: "policy_violation", message: "flagged" },
    ])
  })

  it("stays silent on a normal end_turn", async () => {
    const { lines, notices } = await runAgent({ text: "hello", stopReason: "end_turn" })
    expect(notices).toEqual([])
    expect(lines.find((l) => l.includes("safety layer"))).toBeUndefined()
  })
})

describe("AgentCore.run notice events (max_tokens path)", () => {
  it("emits max_tokens_continuing then completes when the retry ends cleanly", async () => {
    const notices: TurnNotice[] = []
    const agent = await buildTestCore({
      auth,
      sendFn: makeSendFn({}, [
        // round 1: truncated, no tool blocks → auto-continue
        { text: "", stopReason: "max_tokens" },
        // round 2: clean finish
        { text: "done", stopReason: "end_turn" },
      ]),
      eventSink: noticeSink(notices),
      // A continuation needs continue text and, after an empty response,
      // placeholder text: bare core ends the turn truncated instead of
      // sending an empty block or two user turns in a row (follow-up 15a).
      syntheticTextProviders: [
        { kinds: ["continue.max_tokens", "assistant.placeholder"], text: () => "continue" },
      ],
    })
    const gen = agent.run("hi")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      kind: "max_tokens_continuing",
      severity: "warn",
      attempt: 1,
    })
  })
})

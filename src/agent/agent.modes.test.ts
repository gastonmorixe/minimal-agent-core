import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { Message, SendOptions, StreamedResponse } from "../client/types.ts"

import { Agent } from "./agent.ts"

const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

// ---------------------------------------------------------------------------
// Modes integration with Agent.run
//
// Verifies the v2.1.119 cache-friendly mode contract end-to-end at the agent
// level: tools stay registered in the request body, the harness refuses
// disallowed tools at dispatch time, and a `<ma::agent::mode-change>` attachment rides
// the next user turn after a toggle. See `src/modes.test.ts` for the unit
// tests of ModeManager itself, and `work/2026-05-03T02:11:34-04:00-docs-plan-mode-design.md`
// for the design rationale.
// ---------------------------------------------------------------------------

describe("Agent.run with ModeManager (dispatch gate + activation attachment)", () => {
  const ASK_MANIFEST = {
    id: "ask",
    label: "ASK",
    disallowedTools: ["Edit", "Write"],
    refusalHint: "Present the proposed change as a unified diff.",
  }

  // Pinned wall-clock for tests that assert on the literal `<ma::agent::mode-change … at="…" />`
  // payload. Injecting `now` into ModeManager keeps the marker byte-stable.
  const FIXED_AT = new Date("2026-05-22T20:43:12.000Z")
  const FIXED_AT_ISO = FIXED_AT.toISOString()
  const fixedNow = () => FIXED_AT

  /**
   * Build a 2-round sendFn that records every request body it receives,
   * emits a `tool_use(Edit)` on round 1 and a final text on round 2.
   * The recorded bodies let assertions inspect `tools` byte-stability.
   */
  function makeRecordingSendFn(records: Array<Record<string, unknown>>) {
    let round = 0
    return async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      // Snapshot only the cache-relevant top-level fields. Deep-clone so
      // later mutations by other turns can't poison the snapshot.
      records.push(
        JSON.parse(
          JSON.stringify({
            messages: opts.messages,
            tools: opts.tools,
            system: opts.system,
            model: opts.model,
          }),
        ),
      )
      round++
      if (round === 1) {
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "call-1",
              name: "Edit",
              input: { path: "x.ts", oldStr: "a", newStr: "b" },
            },
          ],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
  }

  it("refuses a disallowed tool at dispatch (no executeTool call) and synthesizes is_error tool_result", async () => {
    const { ModeManager } = await import("../modes/modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], "ask")

    const records: Array<Record<string, unknown>> = []
    const sendFn = makeRecordingSendFn(records)
    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })

    const transcript: string[] = []
    const gen = agent.run("please edit foo.ts", {
      onTranscriptLine: (line) => transcript.push(line),
    })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // The tool_result that came back to the model carries the refusal
    // message and is_error: true. We can find it in the messages history
    // appended after round 1.
    const history = agent.history()
    // After: user(initial), assistant(tool_use), user(tool_result), assistant(text)
    expect(history.length).toBe(4)
    const toolResultMsg = history[2]
    expect(toolResultMsg.role).toBe("user")
    const tr = (toolResultMsg.content as unknown as Array<Record<string, unknown>>).find(
      (b) => b.type === "tool_result",
    ) as Record<string, unknown>
    expect(tr).toBeDefined()
    expect(tr.is_error).toBe(true)
    expect(String(tr.content)).toContain('Tool "Edit" is not permitted in ASK mode.')
    expect(String(tr.content)).toContain("unified diff")

    // Transcript must show the denial line so the user sees what was blocked.
    const joinedTranscript = stripAnsi(transcript.join("\n"))
    expect(joinedTranscript).toContain("⊘")
    expect(joinedTranscript).toContain("refused by ask")
  })

  it("--tools allow-list refuses tools not in the list at dispatch (CLI filter before mode)", async () => {
    const { ModeManager } = await import("../modes/modes.ts")
    // --tools "Read" — only Read is allowed. Edit is not in the list.
    const modeManager = new ModeManager([ASK_MANIFEST], "ask", undefined, undefined, undefined, {
      kind: "allow-list",
      tools: ["Read"],
    })

    const records: Array<Record<string, unknown>> = []
    const sendFn = makeRecordingSendFn(records)
    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })

    const transcript: string[] = []
    const gen = agent.run("please edit foo.ts", {
      onTranscriptLine: (line) => transcript.push(line),
    })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const history = agent.history()
    expect(history.length).toBe(4)
    const toolResultMsg = history[2]
    expect(toolResultMsg.role).toBe("user")
    const tr = (toolResultMsg.content as unknown as Array<Record<string, unknown>>).find(
      (b) => b.type === "tool_result",
    ) as Record<string, unknown>
    expect(tr).toBeDefined()
    expect(tr.is_error).toBe(true)
    // The CLI filter message, not the mode refusal message
    expect(String(tr.content)).toContain("not in the --tools allow-list")

    const joinedTranscript = stripAnsi(transcript.join("\n"))
    expect(joinedTranscript).toContain("⊘")
  })

  it("--no-tools refuses every tool at dispatch", async () => {
    const { ModeManager } = await import("../modes/modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], "ask", undefined, undefined, undefined, {
      kind: "deny-all",
    })

    const records: Array<Record<string, unknown>> = []
    const sendFn = makeRecordingSendFn(records)
    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })

    const gen = agent.run("please edit foo.ts")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const history = agent.history()
    expect(history.length).toBe(4)
    const toolResultMsg = history[2]
    expect(toolResultMsg.role).toBe("user")
    const tr = (toolResultMsg.content as unknown as Array<Record<string, unknown>>).find(
      (b) => b.type === "tool_result",
    ) as Record<string, unknown>
    expect(tr).toBeDefined()
    expect(tr.is_error).toBe(true)
    expect(String(tr.content)).toContain("--no-tools is active")
  })

  it("keeps the tools array byte-stable across mode toggles (Edit always advertised)", async () => {
    const { ModeManager } = await import("../modes/modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST])
    // Start with no mode active.
    expect(modeManager.activeId()).toBeNull()

    const records: Array<Record<string, unknown>> = []
    const sendFn = makeRecordingSendFn(records)
    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })

    // Round 1: no mode active, run a turn.
    const gen1 = agent.run("hi")
    while (true) {
      const { done } = await gen1.next()
      if (done) break
    }

    // Toggle into ASK between turns.
    modeManager.setMode("ask")

    // Round 2: ASK active.
    const gen2 = agent.run("now edit foo")
    while (true) {
      const { done } = await gen2.next()
      if (done) break
    }

    // Two `agent.run` calls × two API rounds each = 4 recordings. We
    // care about the `tools` field shape across all of them.
    expect(records.length).toBeGreaterThanOrEqual(2)
    const toolsBefore = JSON.stringify(records[0].tools ?? [])
    const toolsAfter = JSON.stringify(records[records.length - 1].tools ?? [])
    expect(toolsBefore).toBe(toolsAfter)

    // And specifically: Edit and Write are still in the advertised list
    // even with ASK active (the dispatch gate enforces, not request shape).
    const lastToolNames = (records[records.length - 1].tools as Array<{ name: string }>).map(
      (t) => t.name,
    )
    expect(lastToolNames).toContain("Edit")
    expect(lastToolNames).toContain("Write")
  })

  it("attaches a <mode-change> block to the next user message after a toggle, then stops on steady state", async () => {
    const { ModeManager } = await import("../modes/modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], null, undefined, fixedNow)

    // 3-turn sendFn: each turn just emits text and ends.
    let round = 0
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      round++
      yield `r${round}`
      return {
        blocks: [{ type: "text" as const, text: `r${round}` }],
        text: `r${round}`,
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })

    // Turn 1: no toggle yet, no attachment.
    const g1 = agent.run("first")
    while (true) {
      const { done } = await g1.next()
      if (done) break
    }
    const turn1User = (records[0].messages as Array<Record<string, unknown>>)[0]
    const turn1Blocks = turn1User.content as Array<Record<string, unknown>>
    expect(turn1Blocks.length).toBe(1)
    expect(turn1Blocks[0].text).toBe("first")

    // Toggle into ASK between turns.
    modeManager.setMode("ask")

    // Turn 2: attachment should be prepended to the user message.
    const g2 = agent.run("second")
    while (true) {
      const { done } = await g2.next()
      if (done) break
    }
    const turn2User = (records[1].messages as Array<Record<string, unknown>>).at(-2) as Record<
      string,
      unknown
    >
    // Find the user message that was JUST appended (= the second-to-last
    // message in the history at request time, since the trailing assistant
    // hasn't been pushed yet — actually, requests go out BEFORE the
    // assistant reply is appended; so the last message in records[1] is
    // the freshly-pushed user message for round 2).
    const turn2Last = (records[1].messages as Array<Record<string, unknown>>).at(-1) as Record<
      string,
      unknown
    >
    expect(turn2Last.role).toBe("user")
    const turn2Blocks = turn2Last.content as Array<Record<string, unknown>>
    expect(turn2Blocks.length).toBe(2)
    // Pull out just the {type,text} fields — the rolling-cache helper
    // stamps `cache_control` on the last block, which we don't care about
    // here. The mode-change attachment must be the FIRST block (so the
    // model sees the activation context before the user's actual input).
    expect({ type: turn2Blocks[0].type, text: turn2Blocks[0].text }).toEqual({
      type: "text",
      text: `<ma::agent::mode-change from="default" to="ask" at="${FIXED_AT_ISO}" />`,
    })
    expect({ type: turn2Blocks[1].type, text: turn2Blocks[1].text }).toEqual({
      type: "text",
      text: "second",
    })
    // Quiet the unused-binding lint by using turn2User for clarity:
    void turn2User

    // Turn 3: no toggle, no attachment — steady-state ASK.
    const g3 = agent.run("third")
    while (true) {
      const { done } = await g3.next()
      if (done) break
    }
    const turn3Last = (records[2].messages as Array<Record<string, unknown>>).at(-1) as Record<
      string,
      unknown
    >
    const turn3Blocks = turn3Last.content as Array<Record<string, unknown>>
    expect(turn3Blocks.length).toBe(1)
    expect({ type: turn3Blocks[0].type, text: turn3Blocks[0].text }).toEqual({
      type: "text",
      text: "third",
    })
  })

  it("does NOT couple mode addendum into the system prompt (sys[3] is mode-independent)", async () => {
    const { ModeManager } = await import("../modes/modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST])

    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ system: opts.system })))
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })

    // No plugin loader → no pluginBlock → system is undefined either way.
    // What we verify: turn 1 (no mode) and turn 2 (ASK active) produce
    // byte-identical `system` payloads. This is the cache invariant.
    const g1 = agent.run("a")
    while (true) {
      const { done } = await g1.next()
      if (done) break
    }
    modeManager.setMode("ask")
    const g2 = agent.run("b")
    while (true) {
      const { done } = await g2.next()
      if (done) break
    }

    expect(JSON.stringify(records[0].system)).toBe(JSON.stringify(records[1].system))
  })

  // --------------------------------------------------------------------------
  // Regression: "if I quickly change modes mid-tool, it 400s and stops working"
  //
  // Repro from net log 1777796322689-... :
  //   - assistant emits tool_use
  //   - user toggles mode while the tool is running
  //   - on the next request, the user message had `<ma::agent::mode-change>` BEFORE
  //     the tool_result block, which the API rejects:
  //       "tool_use ids were found without tool_result blocks immediately
  //        after"
  //   - rollbackPendingTurn() then popped that user message wholesale,
  //     stripping the tool_result entirely, and every subsequent retry
  //     400'd forever with a dangling tool_use.
  //
  // The fix: tool_results go FIRST in the post-tool user message; the
  // mode-change attachment trails them. And rollbackPendingTurn refuses
  // to discard any user message that contains tool_result blocks.
  // --------------------------------------------------------------------------
  it("places tool_result FIRST and <mode-change> AFTER when a toggle happens mid-tool-loop", async () => {
    const { ModeManager } = await import("../modes/modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], null, undefined, fixedNow)

    let round = 0
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      round++
      if (round === 1) {
        // Simulate the user toggling mode while the tool is being
        // dispatched — by the time userContent is assembled for round 2,
        // the ModeManager has a pending attachment AND a tool_result.
        modeManager.setMode("ask")
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "call-1",
              name: "Edit", // disallowed in ASK → refusal tool_result
              input: { path: "x", oldStr: "a", newStr: "b" },
            },
          ],
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
    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })

    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // Round 2's request body is what would have hit the API. Inspect the
    // last user message it sent.
    const round2Msgs = records[1].messages as Array<Record<string, unknown>>
    const lastUser = round2Msgs.at(-1) as Record<string, unknown>
    expect(lastUser.role).toBe("user")
    const blocks = lastUser.content as Array<Record<string, unknown>>
    // tool_result MUST be the first block (API contract). mode-change
    // attachment trails. No other ordering is acceptable.
    expect(blocks[0].type).toBe("tool_result")
    expect((blocks[0] as { tool_use_id: string }).tool_use_id).toBe("call-1")
    expect(blocks[1].type).toBe("text")
    expect((blocks[1] as { text: string }).text).toBe(
      `<ma::agent::mode-change from="default" to="ask" at="${FIXED_AT_ISO}" />`,
    )
  })

  it("rollbackPendingTurn() refuses to discard a user message containing tool_result blocks", async () => {
    // Construct an Agent and seed history that mirrors the broken state
    // from the net log: an assistant tool_use followed by a user
    // tool_result. A naive rollback would pop the tool_result, leaving a
    // dangling tool_use that 400s on every subsequent send.
    const auth: AuthResult = { type: "api-key", token: "test" }
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
    }
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn,
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok", is_error: false }],
        },
      ],
    })

    const before = agent.history().length
    const removed = agent.rollbackPendingTurn()
    const after = agent.history().length

    // Nothing was popped: the tool_result-bearing user message stays
    // glued to its tool_use parent.
    expect(removed).toBe(false)
    expect(after).toBe(before)
    expect(agent.history()[2].role).toBe("user")
    const lastBlocks = agent.history()[2].content as unknown as Array<Record<string, unknown>>
    expect(lastBlocks[0].type).toBe("tool_result")
  })

  // --------------------------------------------------------------------------
  // Regression: "text-only assistant reply + pending mode change → orphan
  //  tool_use poisons the session"
  //
  // Repro from session 403c71fe-7cc4-4a2a-b080-b3a8eb9872b6:
  //   - turn opens in ASK, user asks for a script
  //   - assistant ends with text only (stopReason: end_turn), no tool_use
  //   - meanwhile user toggled ASK→default, attachment is pending
  //   - the original ASAP path (post-loop one-shot) pushed a synthetic
  //     `<ma::agent::mode-change>` user turn and made one more API call
  //   - the model, seeing the prior prompt was "save this file", returned
  //     `tool_use` on that follow-up call
  //   - the ASAP path did NOT loop through tool execution: orphan tool_use
  //     was persisted to messages and the session JSONL
  //   - every subsequent user submit 400'd with
  //       "tool_use ids were found without tool_result blocks
  //        immediately after"
  //
  // The fix: handle the synthetic turn INSIDE the main while loop's
  // `toolBlocks.length === 0` branch (consume the pending attachment,
  // push the user turn, `continue` so the next iteration handles any
  // tool_use naturally). No more orphans.
  // --------------------------------------------------------------------------
  it("loops synthetic mode-change turn through tool execution (no orphan tool_use)", async () => {
    const { ModeManager } = await import("../modes/modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], "ask", undefined, fixedNow)

    // 3-round sendFn:
    //  round 1: assistant ends with text only (stopReason: end_turn).
    //           The test toggles the mode AFTER round 1's response is
    //           collected but BEFORE the loop's no-tool-blocks branch
    //           runs : simplest place to drive the pending-state.
    //  round 2: synthetic `<ma::agent::mode-change>` user turn was injected
    //           by the agent. Model now responds with `tool_use` (Bash).
    //  round 3: agent has executed the tool and is asking the model
    //           for a final summary. Model returns text + end_turn.
    let round = 0
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      round++
      if (round === 1) {
        // Mid-turn toggle. Pending attachment from ask → default.
        modeManager.setMode(null)
        return {
          blocks: [{ type: "text" as const, text: "here's a script" }],
          text: "here's a script",
          stopReason: "end_turn",
        } as StreamedResponse
      }
      if (round === 2) {
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "bash-1",
              name: "Bash",
              // No actual command needed; the agent's Bash executor will
              // try to run this. We override via a no-op below.
              input: { command: "echo hi", description: "" },
            },
          ],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "saved"
      return {
        blocks: [{ type: "text" as const, text: "saved" }],
        text: "saved",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })
    const gen = agent.run("write a script")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // Invariant 1: three rounds were sent (the synthetic mode-change turn
    // was looped through the tool-execution machinery, not handled as a
    // one-shot post-loop call).
    expect(records.length).toBe(3)

    // Invariant 2: round 2's request body carries a user message whose
    // ONLY block is the `<ma::agent::mode-change>` attachment (synthetic turn).
    const round2Msgs = records[1].messages as Array<Record<string, unknown>>
    const round2LastUser = round2Msgs.at(-1) as Record<string, unknown>
    expect(round2LastUser.role).toBe("user")
    const round2Blocks = round2LastUser.content as Array<Record<string, unknown>>
    expect(round2Blocks.length).toBe(1)
    expect(round2Blocks[0].type).toBe("text")
    expect((round2Blocks[0] as { text: string }).text).toBe(
      `<ma::agent::mode-change from="ask" to="default" at="${FIXED_AT_ISO}" />`,
    )

    // Invariant 3: round 3's request body carries the matching
    // `tool_result` for `bash-1` as the FIRST block of the trailing user
    // message. No orphan tool_use anywhere.
    const round3Msgs = records[2].messages as Array<Record<string, unknown>>
    const round3LastUser = round3Msgs.at(-1) as Record<string, unknown>
    expect(round3LastUser.role).toBe("user")
    const round3Blocks = round3LastUser.content as Array<Record<string, unknown>>
    expect(round3Blocks[0].type).toBe("tool_result")
    expect((round3Blocks[0] as { tool_use_id: string }).tool_use_id).toBe("bash-1")

    // Invariant 4: history ends with the model's final text response
    // (round 3), not the orphan tool_use from the broken ASAP path.
    const history = agent.history()
    const lastMsg = history.at(-1) as Message
    expect(lastMsg.role).toBe("assistant")
    const lastBlocks = lastMsg.content as unknown as Array<Record<string, unknown>>
    expect(lastBlocks.some((b) => b.type === "tool_use")).toBe(false)
    expect(lastBlocks.some((b) => b.type === "text")).toBe(true)
  })

  it("does NOT synthesize a mode-change turn when no toggle is pending", async () => {
    // Steady-state: assistant ends with text only and the mode hasn't
    // changed since the last advertisement. The loop must exit cleanly
    // after one round, not synthesize a phantom user turn.
    const { ModeManager } = await import("../modes/modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], "ask", undefined, fixedNow)

    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })
    // First run carries the initial `<ma::agent::mode-change default → ask>`
    // attachment (mode starts active). After this turn lastAdvertised
    // === active, so subsequent steady-state runs must not add another.
    const g1 = agent.run("first")
    while (true) {
      const { done } = await g1.next()
      if (done) break
    }
    const g2 = agent.run("second")
    while (true) {
      const { done } = await g2.next()
      if (done) break
    }

    // Exactly two rounds (one per `agent.run` call). No synthetic
    // third round.
    expect(records.length).toBe(2)
    // Round 2's last user message is the user's plain prompt only:
    // no synthetic attachment was injected.
    const round2Msgs = records[1].messages as Array<Record<string, unknown>>
    const round2LastUser = round2Msgs.at(-1) as Record<string, unknown>
    const round2Blocks = round2LastUser.content as Array<Record<string, unknown>>
    expect(round2Blocks.length).toBe(1)
    expect((round2Blocks[0] as { text: string }).text).toBe("second")
  })

  it("does NOT synthesize a mode-change turn for a net-zero toggle (ask → default → ask)", async () => {
    // The user toggles mid-turn but lands back where they started by
    // the time the loop exits. ModeManager.consumePendingAttachment
    // returns null in that case (active === lastAdvertised), so no
    // synthetic turn fires.
    const { ModeManager } = await import("../modes/modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], "ask", undefined, fixedNow)

    let round = 0
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      round++
      if (round === 1) {
        // Toggle twice during the round. Net zero.
        modeManager.setMode(null)
        modeManager.setMode("ask")
      }
      yield `r${round}`
      return {
        blocks: [{ type: "text" as const, text: `r${round}` }],
        text: `r${round}`,
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })
    const gen = agent.run("hello")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // One round only. Net-zero toggle does not synthesize a follow-up.
    expect(records.length).toBe(1)
  })

  it("rollbackPendingTurn() still pops a plain-text trailing user message", async () => {
    // Negative control: a user message with NO tool_result blocks (the
    // common case — a plain prompt that the API rejected for some other
    // reason) MUST still be poppable so the user can resubmit cleanly.
    const auth: AuthResult = { type: "api-key", token: "test" }
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
    }
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn,
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "second (failed)" }] },
      ],
    })

    expect(agent.rollbackPendingTurn()).toBe(true)
    expect(agent.history().length).toBe(2)
    expect(agent.history()[1].role).toBe("assistant")
  })

  // --------------------------------------------------------------------------
  // Regression: orphan tool_use poisons every retry
  //
  // Symptom: user aborts a turn (Esc / Ctrl+C / Alt+M) after the assistant
  // has streamed a `tool_use` block but before the for-loop produces a
  // matching `tool_result`. The orphan tool_use stays in `this.messages`.
  // Every subsequent submit ships that orphan to the API, which 400s with
  // "tool_use ids were found without tool_result blocks immediately after".
  //
  // The fix lives in `Agent.repairOrphanedToolUse()` + the prepend hook
  // at the top of `Agent.run()`'s initial-user-content build. Synthetic
  // `is_error: true` tool_results pair the orphans so the next request
  // is well-formed.
  // --------------------------------------------------------------------------
  describe("Agent.repairOrphanedToolUse (abort-orphan repair)", () => {
    it("returns synthetic is_error:true blocks for every orphan tool_use", async () => {
      const auth: AuthResult = { type: "api-key", token: "test" }
      const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
      }
      const agent = new Agent({
        auth,
        model: "test-model",
        sendFn,
        initialMessages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call-a", name: "Bash", input: { command: "ls" } },
              { type: "tool_use", id: "call-b", name: "Read", input: { file_path: "/x" } },
            ],
          },
        ],
      })

      const repair = agent.repairOrphanedToolUse()
      expect(repair.length).toBe(2)
      expect(repair[0]).toEqual({
        type: "tool_result",
        tool_use_id: "call-a",
        content: "Tool execution aborted by user before completion.",
        is_error: true,
      })
      expect(repair[1].tool_use_id).toBe("call-b")
      expect(repair[1].is_error).toBe(true)
    })

    it("returns [] when the trailing assistant message has no tool_use blocks", async () => {
      const auth: AuthResult = { type: "api-key", token: "test" }
      const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
      }
      const agent = new Agent({
        auth,
        model: "test-model",
        sendFn,
        initialMessages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ],
      })
      expect(agent.repairOrphanedToolUse()).toEqual([])
    })

    it("returns [] when the trailing message is a user (clean state)", async () => {
      const auth: AuthResult = { type: "api-key", token: "test" }
      const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
      }
      const agent = new Agent({
        auth,
        model: "test-model",
        sendFn,
        initialMessages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "c1", content: "ok", is_error: false }],
          },
        ],
      })
      expect(agent.repairOrphanedToolUse()).toEqual([])
    })

    it("returns [] when history is empty", async () => {
      const auth: AuthResult = { type: "api-key", token: "test" }
      const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
      }
      const agent = new Agent({ auth, model: "test-model", sendFn })
      expect(agent.repairOrphanedToolUse()).toEqual([])
    })
  })

  it("Agent.run() prepends synthetic tool_results when history starts with an orphaned tool_use", async () => {
    // End-to-end: simulate a session that resumes from a JSONL with an
    // orphaned assistant tool_use (the "Esc-during-Bash + retry" repro
    // from session 403c71fe). Submit a follow-up. The next API request
    // body must have the synthetic tool_result as the FIRST block of
    // the new user message, with the user's text following.
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      yield "got it"
      return {
        blocks: [{ type: "text" as const, text: "got it" }],
        text: "got it",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn,
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "save it" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "sig" },
            { type: "tool_use", id: "bash-orphan", name: "Bash", input: { command: "ls ~/bin" } },
          ],
        },
      ],
    })

    const gen = agent.run("save it in ~/Projects/...")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // Inspect the (only) request body. It must be well-formed:
    //   - 3 messages: original user, assistant(orphan), new user
    //   - The new user message's content must start with a tool_result
    //     for `bash-orphan` (is_error: true) and end with the user text.
    expect(records.length).toBe(1)
    const msgs = records[0].messages as Array<Record<string, unknown>>
    expect(msgs.length).toBe(3)
    const newUser = msgs[2]
    expect(newUser.role).toBe("user")
    const blocks = newUser.content as Array<Record<string, unknown>>
    // First block is the orphan-repair tool_result, second is the text.
    expect(blocks[0].type).toBe("tool_result")
    expect((blocks[0] as { tool_use_id: string }).tool_use_id).toBe("bash-orphan")
    expect((blocks[0] as { is_error: boolean }).is_error).toBe(true)
    expect((blocks[0] as { content: string }).content).toContain("aborted by user")
    // The text block lands after the synthetic result.
    const textBlock = blocks.find((b) => b.type === "text")
    expect(textBlock).toBeDefined()
    expect((textBlock as { text: string }).text).toBe("save it in ~/Projects/...")
  })

  it("Agent.run() does NOT prepend repair blocks when history is clean", async () => {
    // Negative control: a paired session (assistant tool_use + user
    // tool_result) must not receive synthetic blocks. Same shape as the
    // most common state, hot path, MUST stay byte-stable.
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn,
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c1", content: "ok", is_error: false }],
        },
        { role: "assistant", content: [{ type: "text", text: "ack" }] },
      ],
    })

    const gen = agent.run("next thing")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const msgs = records[0].messages as Array<Record<string, unknown>>
    const newUser = msgs[msgs.length - 1]
    const blocks = newUser.content as Array<Record<string, unknown>>
    // No tool_result blocks in a clean-state continuation.
    expect(blocks.some((b) => b.type === "tool_result")).toBe(false)
    // Just the user's text.
    expect(blocks[0].type).toBe("text")
    expect((blocks[0] as { text: string }).text).toBe("next thing")
  })
})

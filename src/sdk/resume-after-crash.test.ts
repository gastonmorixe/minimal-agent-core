/**
 * Round checkpoints and resume-after-crash (spec v2 section 2.2, S50).
 *
 * A fake transport drives a turn through two rounds of tool calls. Round 3
 * (a thrown, non-classified error from the transport — not a provider wire
 * error, so `decideNext` never sees it) simulates a kill: `AgentCore.run`'s
 * top-level catch emits one `error` event and rethrows, same as an
 * uncaught crash would leave the process. A second `AgentCore`, built from
 * the first one's persisted history and its last round checkpoint, resumes
 * the turn with `run(input, {resume: true})` and the run continues at
 * round 3 instead of replaying rounds 1 and 2.
 *
 * @module sdk/resume-after-crash.test
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { ContentBlock, Message, ToolResultBlock } from "../llm/messages.ts"
import type { StreamedResponse, TransportFn } from "../llm/transport/types.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import type { AgentEvent } from "./events.ts"
import type { AgentCoreConfig, SessionPersistence } from "./ports.ts"
import type { Streaks } from "./stop-policy.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/**
 * A `SessionPersistence` fake that keeps everything in memory, including
 * the one record real `SessionStore` adds for S50: the round checkpoint.
 * `records` is a flat append-only log, like the real JSONL — good enough
 * to prove the resume path without a file on disk.
 */
class FakeSessionPersistence implements SessionPersistence {
  readonly records: Array<{ kind: string; [k: string]: unknown }> = []
  lastCheckpoint: { round: number; streaks: Streaks } | undefined

  appendUser(content: string | ContentBlock[]): string {
    const id = `u${this.records.length}`
    this.records.push({ kind: "user", content, id })
    return id
  }
  appendAssistant(content: ContentBlock[], stopReason: string | null): void {
    this.records.push({ kind: "assistant", content, stopReason })
  }
  appendToolResult(result: ToolResultBlock): void {
    this.records.push({ kind: "tool_result", result })
  }
  appendNote(text: string): void {
    this.records.push({ kind: "note", text })
  }
  appendRewind(): void {}
  appendRoundCheckpoint(checkpoint: { round: number; streaks: Streaks }): void {
    this.lastCheckpoint = checkpoint
    this.records.push({ kind: "round_checkpoint", ...checkpoint })
  }
}

function toolUseResponse(id: string): StreamedResponse {
  return {
    blocks: [{ type: "tool_use", id, name: "Bash", input: {} }],
    text: "",
    stopReason: "tool_use",
  }
}

const finalResponse: StreamedResponse = {
  blocks: [{ type: "text", text: "all done" }],
  text: "all done",
  stopReason: "end_turn",
}

function buildCore(
  sendFn: TransportFn,
  events: AgentEvent[],
  over: Partial<AgentCoreConfig> = {},
): AgentCore {
  return new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "ok", isError: false }) },
    eventSink: { emit: (e) => events.push(e) },
    sendFn,
    ...over,
  })
}

async function drain(gen: AsyncGenerator<string, TurnResult, undefined>): Promise<TurnResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

describe("AgentCore round checkpoints and resume-after-crash (S50)", () => {
  it("checkpoints after each completed round, and a resumed run continues at the next round", async () => {
    // Round 1 and 2 run tool calls; round 3 (post-crash) would end the
    // turn — but the first process never gets there.
    let calls = 0
    const crashingSendFn: TransportFn = async function* () {
      calls++
      if (calls === 1) return toolUseResponse("t1")
      if (calls === 2) return toolUseResponse("t2")
      // Round 3: the kill. A non-classified thrown error is a bug/crash
      // path, not a wire failure `decideNext` retries — it propagates,
      // same as an uncaught exception that takes the process down.
      throw new Error("process killed")
    }

    const persistence = new FakeSessionPersistence()
    const eventsBeforeCrash: AgentEvent[] = []
    const agentBeforeCrash = buildCore(crashingSendFn, eventsBeforeCrash, {
      sessionPersistence: persistence,
    })

    await expect(drain(agentBeforeCrash.run("go"))).rejects.toThrow("process killed")
    expect(calls).toBe(3)

    // Round 2 checkpointed before the crash; round 3 never got the chance.
    expect(persistence.lastCheckpoint).toEqual({
      round: 2,
      streaks: { maxTokens: 0, interrupted: 0 },
    })
    const turnStarted = eventsBeforeCrash.filter((e) => e.type === "turn_started")
    expect(turnStarted.map((e) => (e.type === "turn_started" ? e.turn : -1))).toEqual([1, 2, 3])

    // "Restart": a fresh AgentCore, seeded from the first one's history
    // (what a real restart loads back from the session's JSONL) and its
    // last round checkpoint.
    const historyAtCrash: Message[] = agentBeforeCrash.history()
    let resumedCalls = 0
    const resumedSendFn: TransportFn = async function* () {
      resumedCalls++
      return finalResponse
    }
    const eventsAfterResume: AgentEvent[] = []
    const resumedPersistence = new FakeSessionPersistence()
    const resumedAgent = buildCore(resumedSendFn, eventsAfterResume, {
      initialMessages: historyAtCrash,
      initialCheckpoint: persistence.lastCheckpoint,
      sessionPersistence: resumedPersistence,
    })

    const result = await drain(resumedAgent.run("", { resume: true }))

    expect(result.outcome).toBe("completed")
    // Exactly one more send: round 3. Rounds 1 and 2 are not replayed.
    expect(resumedCalls).toBe(1)
    const resumedTurnStarted = eventsAfterResume.filter((e) => e.type === "turn_started")
    expect(resumedTurnStarted).toEqual([{ type: "turn_started", turn: 3 }])
    // The pre-crash history (both tool rounds) is still there, unreplayed,
    // followed by the final turn's text.
    const roles = resumedAgent.history().map((m) => m.role)
    expect(roles).toEqual(historyAtCrash.map((m) => m.role).concat(["assistant"]))
  })

  /** Run 1 (two tool rounds, crash in round 3), then a fresh core seeded from it. */
  async function crashThenReopen(events: AgentEvent[], sent: Message[][]) {
    let calls = 0
    const persistence = new FakeSessionPersistence()
    const before = buildCore(
      async function* () {
        calls++
        if (calls <= 2) return toolUseResponse(`t${calls}`)
        throw new Error("process killed")
      },
      [],
      { sessionPersistence: persistence },
    )
    await expect(drain(before.run("go"))).rejects.toThrow("process killed")
    const history = before.history()
    const reopened = buildCore(
      async function* (opts) {
        sent.push(JSON.parse(JSON.stringify(opts.messages)))
        return finalResponse
      },
      events,
      {
        initialMessages: history,
        initialCheckpoint: persistence.lastCheckpoint,
        sessionPersistence: new FakeSessionPersistence(),
      },
    )
    return { reopened, history }
  }

  it("/continue (noteSessionResumed) continues the unfinished turn at the next round", async () => {
    const events: AgentEvent[] = []
    const sent: Message[][] = []
    const { reopened, history } = await crashThenReopen(events, sent)

    reopened.noteSessionResumed()
    const result = await drain(reopened.run(""))

    expect(result.outcome).toBe("completed")
    expect(events.filter((e) => e.type === "turn_started")).toEqual([
      { type: "turn_started", turn: 3 },
    ])
    // No new user turn and no resumed marker: the request is the history at
    // the crash (the send adds only a cache breakpoint).
    expect(sent).toHaveLength(1)
    expect(sent[0]?.map((m) => m.role)).toEqual(history.map((m) => m.role))
    expect(JSON.stringify(sent[0]?.at(-1))).toContain('"tool_use_id":"t2"')
  })

  it("/continue with no unfinished turn keeps the resumed-marker turn", async () => {
    const events: AgentEvent[] = []
    const sent: Message[][] = []
    const core = buildCore(async function* (opts) {
      sent.push(JSON.parse(JSON.stringify(opts.messages)))
      return finalResponse
    }, events)

    core.noteSessionResumed()
    await drain(core.run(""))

    // A fresh turn at round 1, not a resume. (The marker text itself is
    // covered by agent.session-resumed.test.ts: a bare core has none.)
    expect(events.filter((e) => e.type === "turn_started")).toEqual([
      { type: "turn_started", turn: 1 },
    ])
    expect(sent).toHaveLength(1)
  })

  it("a new message on a reopened core starts a new turn at round 1", async () => {
    const events: AgentEvent[] = []
    const sent: Message[][] = []
    const { reopened, history } = await crashThenReopen(events, sent)

    const result = await drain(reopened.run("something else"))

    expect(result.outcome).toBe("completed")
    expect(events.filter((e) => e.type === "turn_started")).toEqual([
      { type: "turn_started", turn: 1 },
    ])
    // The new text joins the last tool-result message: roles still alternate.
    const request = sent[0] ?? []
    expect(request).toHaveLength(history.length)
    expect(JSON.stringify(request.at(-1))).toContain("something else")
  })
})

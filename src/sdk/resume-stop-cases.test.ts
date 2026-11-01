/**
 * Round checkpoints after a stop (decision 31, S50).
 *
 * - A user abort (Ctrl-C) clears the round checkpoint, so `--resume` never
 *   continues a turn the user cancelled.
 * - A kill keeps the checkpoint. A tool call that ran at the kill is never
 *   run again by itself: on resume the history keeps its `tool_use` and
 *   gets a synthetic error `tool_result` that tells the model to check the
 *   effects first.
 *
 * The session log is a real `SessionStore` file on disk, read back with
 * `loadSession`, the same path `--resume` uses.
 *
 * @module sdk/resume-stop-cases.test
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { toolCallInterruptedByStopResult } from "../agent/PROMPTS.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { ContentBlock, Message } from "../llm/messages.ts"
import type { StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import { SessionStorePersistence } from "../runtime/session-persistence-store.ts"
import { lastTurnRoundCheckpoint, loadSession } from "../session/session-restore.ts"
import { SessionStore } from "../session/session-store.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import type { AgentCoreConfig } from "./ports.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const NOTE =
  "The process stopped while this tool call ran. It may have run fully, partly, or not at all. Check its effects before you run it again."

function openStore(dir: string, sid: string, existsOk = false): SessionStore {
  return SessionStore.open({
    sid,
    model: "test-model",
    cwd: dir,
    systemHash: "h",
    toolsHash: "h",
    agentVersion: "test",
    dir,
    existsOk,
  })
}

function toolUse(id: string): ContentBlock {
  return { type: "tool_use", id, name: "Bash", input: { command: `echo ${id}` } }
}

const finalResponse: StreamedResponse = {
  blocks: [{ type: "text", text: "all done" }],
  text: "all done",
  stopReason: "end_turn",
}

function buildCore(sendFn: TransportFn, over: Partial<AgentCoreConfig>): AgentCore {
  return new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "ok", isError: false }) },
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

/** Round 1 asks for a tool. Round 2 runs `round2`. */
function twoRoundSendFn(round2: () => void): TransportFn {
  let calls = 0
  return async function* () {
    calls++
    if (calls === 1) {
      return { blocks: [toolUse("t1")], text: "", stopReason: "tool_use" } as StreamedResponse
    }
    round2()
    yield "x"
    return finalResponse
  }
}

describe("round checkpoint after a user abort (decision 31)", () => {
  it("a Ctrl-C abort in round 2 clears the checkpoint, so resume finds no unfinished turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-abort-cp-"))
    const ctrl = new AbortController()
    const agent = buildCore(
      twoRoundSendFn(() => ctrl.abort()),
      { sessionPersistence: new SessionStorePersistence(openStore(dir, "ab")) },
    )
    await expect(drain(agent.run("go", { signal: ctrl.signal }))).rejects.toThrow("aborted")
    expect(lastTurnRoundCheckpoint(loadSession("ab", dir).records)).toBeNull()
  })

  it("a crash in round 2 keeps the round 1 checkpoint, so resume continues the turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-crash-cp-"))
    const agent = buildCore(
      twoRoundSendFn(() => {
        throw new Error("process killed")
      }),
      { sessionPersistence: new SessionStorePersistence(openStore(dir, "cr")) },
    )
    await expect(drain(agent.run("go"))).rejects.toThrow("process killed")
    expect(lastTurnRoundCheckpoint(loadSession("cr", dir).records)?.round).toBe(1)
  })
})

describe("tool call cut off by a kill, on resume (decision 31)", () => {
  /**
   * Write the log a SIGKILL leaves: round 1 done and checkpointed, round 2
   * asked for `calls`, and only the `done` ones wrote a result.
   */
  function killedLog(dir: string, sid: string, calls: string[], done: string[]): void {
    const store = openStore(dir, sid)
    store.appendUser("go")
    store.appendAssistant([toolUse("t1")], "tool_use")
    store.appendToolResult({ type: "tool_result", tool_use_id: "t1", content: "ok" })
    store.appendRoundCheckpoint({ round: 1, maxTokensStreak: 0, interruptedStreak: 0 })
    store.appendAssistant(calls.map(toolUse), "tool_use")
    for (const id of done) {
      store.appendToolResult({ type: "tool_result", tool_use_id: id, content: "ok" })
    }
  }

  async function resume(dir: string, sid: string) {
    const loaded = loadSession(sid, dir)
    const checkpoint = lastTurnRoundCheckpoint(loaded.records)
    expect(checkpoint?.round).toBe(1)
    const sent: Message[][] = []
    let executed = 0
    const agent = buildCore(
      async function* (opts) {
        sent.push(structuredClone(opts.messages))
        return finalResponse
      },
      {
        initialMessages: loaded.messages,
        ...(checkpoint ? { initialCheckpoint: checkpoint } : {}),
        sessionPersistence: new SessionStorePersistence(openStore(dir, sid, true)),
        toolExecutor: {
          execute: async () => {
            executed++
            return { content: "ok", isError: false }
          },
        },
      },
    )
    const result = await drain(agent.run("", { resume: true }))
    return { result, sent, executed }
  }

  /** The tool_result blocks that follow the assistant message that asked for `id`. */
  function resultsAfter(history: Message[], id: string): ContentBlock[] {
    const at = history.findIndex(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_use" && b.id === id),
    )
    expect(at).toBeGreaterThanOrEqual(0)
    const next = history[at + 1]
    expect(next?.role).toBe("user")
    return Array.isArray(next?.content) ? next.content.filter((b) => b.type === "tool_result") : []
  }

  it("keeps the cut-off tool_use, pairs it with the note, and does not run the tool again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-kill-tool-"))
    killedLog(dir, "k1", ["t2"], [])
    const { result, sent, executed } = await resume(dir, "k1")
    expect(result.outcome).toBe("completed")
    expect(executed).toBe(0)
    expect(sent).toHaveLength(1)
    expect(resultsAfter(sent[0], "t2")).toMatchObject([
      { type: "tool_result", tool_use_id: "t2", content: NOTE, is_error: true },
    ])
    expect(toolCallInterruptedByStopResult()).toBe(NOTE)
    // The pair is on disk too, so a later load still shows it.
    expect(resultsAfter(loadSession("k1", dir).messages, "t2")).toHaveLength(1)
  })

  it("keeps the results that finished and adds the note only for the cut-off call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-kill-tool2-"))
    killedLog(dir, "k2", ["t2", "t3"], ["t2"])
    const { sent, executed } = await resume(dir, "k2")
    expect(executed).toBe(0)
    expect(resultsAfter(sent[0], "t2")).toMatchObject([
      { type: "tool_result", tool_use_id: "t2", content: "ok" },
      { type: "tool_result", tool_use_id: "t3", content: NOTE, is_error: true },
    ])
  })
})

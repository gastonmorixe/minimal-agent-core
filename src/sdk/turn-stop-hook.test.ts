/**
 * Part 2 core seams on a real `AgentCore`: `turn.willStop` continuation and
 * cap, `addSessionContext` one-shot session context, `run`
 * `additionalContext` next to the prompt, and `session.willStart` with
 * source `compact` after a compaction.
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { ContentBlock, Message } from "../llm/messages.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import type { AgentEvent } from "./events.ts"
import {
  allowDecision,
  denyDecision,
  type LifecyclePort,
  type SessionWillStartPayload,
  type TurnWillStopPayload,
} from "./lifecycle.ts"
import type { AgentCoreConfig, SessionPersistence } from "./ports.ts"
import { insertSessionContext } from "./session-context.ts"
import {
  DEFAULT_MAX_STOP_HOOK_HALTS,
  DEFAULT_STOP_HOOK_REASON,
  resolveMaxStopHookHalts,
} from "./turn-stop-hook.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/** A transport that answers `text-N` and records each request as JSON. */
function recorder(): { sendFn: TransportFn; requests: SendOptions[] } {
  const requests: SendOptions[] = []
  let n = 0
  const sendFn: TransportFn = async function* (opts) {
    requests.push(JSON.parse(JSON.stringify(opts)) as SendOptions)
    n++
    return {
      blocks: [{ type: "text", text: `text-${n}` }],
      text: `text-${n}`,
      stopReason: "end_turn",
    } as StreamedResponse
  }
  return { sendFn, requests }
}

function core(sendFn: TransportFn, over: Partial<AgentCoreConfig> = {}) {
  const events: AgentEvent[] = []
  const agent = new AgentCore({
    auth: AUTH,
    model: "test-model-1",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    eventSink: { emit: (e) => events.push(e) },
    sendFn,
    ...over,
  })
  return { agent, events }
}

async function drain(gen: AsyncGenerator<string, TurnResult, undefined>): Promise<TurnResult> {
  for (;;) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

const systemText = (req: SendOptions | undefined): string => JSON.stringify(req?.system ?? [])
/** The block texts of the last message of a request (cache markers ignored). */
const lastTexts = (req: SendOptions | undefined): string[] => {
  const c = req?.messages.at(-1)?.content
  if (typeof c === "string") return [c]
  return (c ?? []).map((b) => (b.type === "text" ? b.text : b.type))
}
const userTexts = (m: Message[]): string[] =>
  m
    .filter((x) => x.role === "user")
    .map((x) => (typeof x.content === "string" ? x.content : JSON.stringify(x.content)))

describe("turn.willStop", () => {
  it("a halt appends a continuation note and runs another round", async () => {
    const seen: TurnWillStopPayload[] = []
    let calls = 0
    const lifecycle: LifecyclePort = {
      async beforeTurnStop(p) {
        seen.push(p)
        calls++
        return calls === 1 ? denyDecision("run the tests", p, ["ctx line"]) : allowDecision(p)
      },
    }
    const { sendFn, requests } = recorder()
    const sessionFacts = () => ({ sid: "s1", agentId: "A1", leadSid: "L1", cwd: "/w" })
    const { agent } = core(sendFn, { lifecycle, sessionFacts })
    const result = await drain(agent.run("go"))

    expect(requests.length).toBe(2)
    expect(result.outcome).toBe("completed")
    expect(seen.map((p) => p.stopHookActive)).toEqual([false, true])
    expect(seen[0]?.lastAssistantText).toBe("text-1")
    expect(seen[1]?.lastAssistantText).toBe("text-2")
    // The identity comes from the host `sessionFacts`. `cwd` is not part of it.
    expect(seen[0]).toMatchObject({ sid: "s1", agentId: "A1", leadSid: "L1" })
    expect(seen[0]).not.toHaveProperty("cwd")
    const users = userTexts(agent.messages)
    expect(users.length).toBe(2)
    expect(users[1]).toContain("<ma::agent::policy>run the tests</ma::agent::policy>")
    expect(users[1]).toContain("<ma::agent::policy>ctx line</ma::agent::policy>")
  })

  it("no halt ends the turn, and allow context is ignored", async () => {
    const lifecycle: LifecyclePort = {
      async beforeTurnStop(p) {
        return allowDecision(p, ["ignored"])
      },
    }
    const { sendFn, requests } = recorder()
    const { agent } = core(sendFn, { lifecycle })
    await drain(agent.run("go"))
    expect(requests.length).toBe(1)
    expect(JSON.stringify(agent.messages)).not.toContain("ignored")
  })

  it("the cap stops honoring halts and ends the turn with a notice", async () => {
    let calls = 0
    const lifecycle: LifecyclePort = {
      async beforeTurnStop(p) {
        calls++
        return denyDecision("again", p)
      },
    }
    const { sendFn, requests } = recorder()
    const { agent, events } = core(sendFn, { lifecycle, maxStopHookHalts: 2 })
    const result = await drain(agent.run("go"))
    expect(requests.length).toBe(3)
    expect(calls).toBe(3)
    expect(result.outcome).toBe("completed")
    const notices = events.filter((e) => e.type === "notice")
    expect(notices).toContainEqual({
      type: "notice",
      notice: { kind: "stop_hook_capped", severity: "warn", cap: 2 },
    })

    // The counter resets at the next turn: two more halts are honored.
    await drain(agent.run("again"))
    expect(requests.length).toBe(6)
  })

  it("a halt with a blank reason uses the default reason", async () => {
    let calls = 0
    const lifecycle: LifecyclePort = {
      async beforeTurnStop(p) {
        calls++
        return calls === 1 ? { action: "deny", reason: " " } : allowDecision(p)
      },
    }
    const { sendFn, requests } = recorder()
    const { agent } = core(sendFn, { lifecycle })
    await drain(agent.run("go"))
    expect(requests.length).toBe(2)
    expect(userTexts(agent.messages)[1]).toContain(
      `<ma::agent::policy>${DEFAULT_STOP_HOOK_REASON}</ma::agent::policy>`,
    )
    expect(DEFAULT_STOP_HOOK_REASON).toBe("Turn stop blocked by turn.willStop hook.")
  })

  it("with no sessionFacts, the payload has no identity fields", async () => {
    const seen: TurnWillStopPayload[] = []
    const lifecycle: LifecyclePort = {
      async beforeTurnStop(p) {
        seen.push(p)
        return allowDecision(p)
      },
    }
    await drain(core(recorder().sendFn, { lifecycle }).agent.run("go"))
    expect(seen[0]).toEqual({ lastAssistantText: "text-1", stopHookActive: false })
  })

  it("resolves the cap default", () => {
    expect(resolveMaxStopHookHalts(undefined)).toBe(DEFAULT_MAX_STOP_HOOK_HALTS)
    expect(DEFAULT_MAX_STOP_HOOK_HALTS).toBe(8)
    expect(resolveMaxStopHookHalts(-1)).toBe(8)
    expect(resolveMaxStopHookHalts(2.7)).toBe(2)
  })
})

/** A session persistence stub that records each user record. */
function userRecords(): { persistence: SessionPersistence; users: ContentBlock[][] } {
  const users: ContentBlock[][] = []
  const persistence: SessionPersistence = {
    appendUser(content) {
      users.push(typeof content === "string" ? [{ type: "text", text: content }] : [...content])
      return `m${users.length}`
    },
    appendAssistant() {},
    appendToolResult() {},
    appendNote() {},
    appendRewind() {},
  }
  return { persistence, users }
}

const HELLO = "<ma::agent::policy>session hello</ma::agent::policy>"

describe("addSessionContext", () => {
  it("puts one block after the user text (strings mean after), keeps the system prompt the same", async () => {
    const plain = recorder()
    await drain(core(plain.sendFn).agent.run("one"))

    const { sendFn, requests } = recorder()
    const { persistence, users } = userRecords()
    const { agent } = core(sendFn, { sessionPersistence: persistence })
    agent.addSessionContext(["session hello", "  "])
    await drain(agent.run("one"))
    await drain(agent.run("two"))

    // The system prompt is the same bytes as with no session context.
    expect(systemText(requests[0])).toBe(systemText(plain.requests[0]))
    expect(systemText(requests[0])).not.toContain("session hello")
    expect(systemText(requests[1])).toBe(systemText(requests[0]))
    // First user message: the user text, then the context block.
    expect(lastTexts(requests[0])).toEqual(["one", HELLO])
    // Persisted in the same user record.
    expect(users[0]).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: HELLO },
    ])
    // It stays in history for the later request, and is not added again.
    expect(lastTexts({ messages: requests[1]?.messages.slice(0, 1) } as SendOptions)).toEqual([
      "one",
      HELLO,
    ])
    expect(lastTexts(requests[1])).toEqual(["two"])
    expect(JSON.stringify(requests[1]?.messages).split("session hello").length - 1).toBe(1)
    expect(JSON.stringify(users).split("session hello").length - 1).toBe(1)
  })

  it("is attached one time only, also inside a turn with more rounds", async () => {
    let calls = 0
    const lifecycle: LifecyclePort = {
      async beforeTurnStop(p) {
        calls++
        return calls === 1 ? denyDecision("more", p) : allowDecision(p)
      },
    }
    const { sendFn, requests } = recorder()
    const { agent } = core(sendFn, { lifecycle })
    agent.addSessionContext(["once"])
    await drain(agent.run("go"))
    expect(requests.length).toBe(2)
    expect(systemText(requests[1])).not.toContain("once")
    expect(JSON.stringify(requests[1]?.messages).split("once").length - 1).toBe(1)
  })

  it("orders the blocks: user text, session context, run additionalContext", async () => {
    const { sendFn, requests } = recorder()
    const { agent } = core(sendFn)
    agent.addSessionContext(["s"])
    await drain(agent.run("p", { additionalContext: ["t"] }))
    expect(lastTexts(requests[0])).toEqual([
      "p",
      "<ma::agent::policy>s</ma::agent::policy>",
      "<ma::agent::policy>t</ma::agent::policy>",
    ])
  })
})

describe("session context queued during a turn", () => {
  it("goes into the next user message after the tool results, and is persisted", async () => {
    const requests: SendOptions[] = []
    let n = 0
    const sendFn: TransportFn = async function* (opts) {
      requests.push(JSON.parse(JSON.stringify(opts)) as SendOptions)
      n++
      if (n === 1) {
        return {
          blocks: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      return { blocks: [{ type: "text", text: "done" }], text: "done", stopReason: "end_turn" }
    }
    const { persistence, users } = userRecords()
    let agent: AgentCore | undefined
    ;({ agent } = core(sendFn, {
      sessionPersistence: persistence,
      toolRegistry: { list: () => [{ name: "x", description: "x", input_schema: {} }] },
      toolExecutor: {
        execute: async () => {
          agent?.addSessionContext(["mid turn"])
          return { content: "ok", isError: false }
        },
      },
    }))
    await drain(agent.run("go"))
    expect(requests.length).toBe(2)
    const texts = lastTexts(requests[1])
    expect(texts[0]).toBe("tool_result")
    expect(texts[1]).toBe("<ma::agent::policy>mid turn</ma::agent::policy>")
    expect(JSON.stringify(users)).toContain("mid turn")
    expect(systemText(requests[1])).toBe(systemText(requests[0]))
  })
})

describe("insertSessionContext", () => {
  it("keeps leading tool_result blocks first", () => {
    const content: ContentBlock[] = [
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "text", text: "after" },
    ]
    insertSessionContext(content, "ctx")
    expect(content.map((b) => (b.type === "text" ? b.text : b.type))).toEqual([
      "tool_result",
      "ctx",
      "after",
    ])
    expect(insertSessionContext(content, "")).toBeNull()
    expect(content.length).toBe(3)
  })
})

describe("run additionalContext", () => {
  it("adds the lines right after the prompt in the same request", async () => {
    const { sendFn, requests } = recorder()
    const { agent } = core(sendFn)
    await drain(agent.run("the prompt", { additionalContext: ["turn ctx", ""] }))
    const first = requests[0]?.messages.at(-1)
    expect(first?.role).toBe("user")
    expect(first?.content).toEqual([
      { type: "text", text: "the prompt" },
      expect.objectContaining({
        type: "text",
        text: "<ma::agent::policy>turn ctx</ma::agent::policy>",
      }),
    ])
    await drain(agent.run("next"))
    expect(JSON.stringify(requests[1]?.messages.at(-1))).not.toContain("turn ctx")
  })
})

describe("session.willStart after compaction", () => {
  it("emits source compact and feeds its context to the next request", async () => {
    const started: SessionWillStartPayload[] = []
    const lifecycle: LifecyclePort = {
      // A deny on the compaction send gives a stub checkpoint with no network.
      async beforeSend(p) {
        return p.compact ? denyDecision("no network in tests") : allowDecision(p)
      },
      async sessionWillStart(p) {
        started.push(p)
        return { additionalContext: ["after compact"] }
      },
    }
    const { sendFn, requests } = recorder()
    const { agent } = core(sendFn, {
      lifecycle,
      modeProvider: { activeModeId: () => "ask" },
      sessionFacts: () => ({ sid: "s1", cwd: "/host/cwd" }),
    })
    for (let i = 0; i < 8; i++) {
      agent.messages.push({ role: "user", content: `u${i}` })
      agent.messages.push({ role: "assistant", content: `a${i}` })
    }
    await agent.compact({ reason: "manual", mode: "local" })
    expect(started.length).toBe(1)
    expect(started[0]?.source).toBe("compact")
    expect(started[0]?.model).toBe("test-model-1")
    expect(started[0]?.sid).toBe("s1")
    expect(started[0]?.cwd).toBe("/host/cwd")

    await drain(agent.run("go"))
    expect(systemText(requests[0])).not.toContain("after compact")
    // A string entry means "after": the block follows the user text.
    expect(lastTexts(requests[0])).toEqual([
      "go",
      "<ma::agent::policy>after compact</ma::agent::policy>",
    ])
  })
})

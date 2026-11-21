/**
 * Session context dedupe on resume: a block with the same wrapped text in
 * the current history gives no second block. Different text gives a new one.
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { Message } from "../llm/messages.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import { wrapHookContext } from "./hook-context.ts"
import { historyHasSessionBlock, SessionContextQueue } from "./session-context.ts"

/** The real codec (sibling checkout), else `NO_SIDEBAND`. The dedupe tests skip without it. */
const SB = fixtureSidebandOrNone()

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

function agentWith(history: Message[]): { agent: AgentCore; requests: SendOptions[] } {
  const requests: SendOptions[] = []
  const sendFn: TransportFn = async function* (opts) {
    requests.push(JSON.parse(JSON.stringify(opts)) as SendOptions)
    return {
      blocks: [{ type: "text", text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
  const agent = new AgentCore({
    auth: AUTH,
    model: "test-model-1",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    sendFn,
    initialMessages: history,
    sideband: SB,
  })
  return { agent, requests }
}

async function drain(gen: AsyncGenerator<string, TurnResult, undefined>): Promise<TurnResult> {
  for (;;) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

const countBlocks = (messages: readonly Message[], text: string): number => {
  let n = 0
  for (const m of messages) {
    if (m.role !== "user") continue
    if (typeof m.content === "string") {
      if (m.content === text) n++
      continue
    }
    for (const b of m.content) if (b.type === "text" && b.text === text) n++
  }
  return n
}

describe.skipIf(!sidebandFixturePresent())("session context dedupe", () => {
  const block = wrapHookContext(SB, ["branch main"])
  const history: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: block },
        { type: "text", text: "hi" },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ]

  it("an identical block in the history adds no second block", async () => {
    const { agent, requests } = agentWith(structuredClone(history))
    agent.addSessionContext(["branch main"])
    await drain(agent.run("go"))
    expect(countBlocks(agent.messages, block)).toBe(1)
    expect(JSON.stringify(requests[0]?.messages.at(-1))).not.toContain("branch main")
  })

  it("different content adds a new block", async () => {
    const { agent } = agentWith(structuredClone(history))
    agent.addSessionContext(["branch dev"])
    await drain(agent.run("go"))
    const fresh = wrapHookContext(SB, ["branch dev"])
    expect(countBlocks(agent.messages, fresh)).toBe(1)
    expect(countBlocks(agent.messages, block)).toBe(1)
  })

  it("the queue take gives an empty text for a known block and empties the queue", () => {
    const q = new SessionContextQueue()
    q.add(["branch main"])
    expect(q.take(SB, history)).toEqual({ before: "", after: "" })
    expect(q.take(SB, history)).toEqual({ before: "", after: "" })
    q.add(["branch main"])
    expect(q.take(SB, [])).toEqual({ before: "", after: block })
    expect(historyHasSessionBlock(SB, history, block)).toBe(true)
    expect(historyHasSessionBlock(SB, history, wrapHookContext(SB, ["x"]))).toBe(false)
  })

  it("compares the policy bodies, not the bytes (design section 4)", () => {
    const two = wrapHookContext(SB, ["a", "b"])
    // Same bodies in the same order, other bytes between the tags: a known block.
    const spaced = two.replace("\n", "\n\n")
    expect(spaced).not.toBe(two)
    const old: Message[] = [{ role: "user", content: [{ type: "text", text: spaced }] }]
    expect(historyHasSessionBlock(SB, old, two)).toBe(true)
    // Other order, fewer lines, or more lines: not the same block.
    expect(historyHasSessionBlock(SB, old, wrapHookContext(SB, ["b", "a"]))).toBe(false)
    expect(historyHasSessionBlock(SB, old, wrapHookContext(SB, ["a"]))).toBe(false)
    expect(historyHasSessionBlock(SB, old, wrapHookContext(SB, ["a", "b", "c"]))).toBe(false)
    // A user text that holds the tag and other words is not a session block.
    const mixed: Message[] = [{ role: "user", content: `see ${wrapHookContext(SB, ["a"])}` }]
    expect(historyHasSessionBlock(SB, mixed, wrapHookContext(SB, ["a"]))).toBe(false)
    // A string content with the same bodies counts too.
    const str: Message[] = [{ role: "user", content: spaced }]
    expect(historyHasSessionBlock(SB, str, two)).toBe(true)
  })

  it("a user-typed message of only the same policy tags matches (accepted risk, m2)", () => {
    // Session blocks carry no mark, so core cannot tell a typed tag from a
    // harness block. The documented result: the take gives no second block.
    const block = wrapHookContext(SB, ["branch main"])
    const typedBlock: Message[] = [{ role: "user", content: [{ type: "text", text: block }] }]
    const typedString: Message[] = [{ role: "user", content: block }]
    expect(historyHasSessionBlock(SB, typedBlock, block)).toBe(true)
    expect(historyHasSessionBlock(SB, typedString, block)).toBe(true)
    const q = new SessionContextQueue()
    q.add(["branch main"])
    expect(q.take(SB, typedString)).toEqual({ before: "", after: "" })
    // A typed message with other words is not a match.
    const mixed: Message[] = [{ role: "user", content: `please ${block}` }]
    expect(historyHasSessionBlock(SB, mixed, block)).toBe(false)
  })
})

describe("session context with no codec (NO_SIDEBAND)", () => {
  it("keeps the texts with no wrapper, and only the same bytes count for the dedupe", () => {
    const q = new SessionContextQueue()
    q.add(["branch main", { text: "first", position: "before" }])
    expect(q.take(NO_SIDEBAND, [])).toEqual({ before: "first", after: "branch main" })
    const h: Message[] = [{ role: "user", content: [{ type: "text", text: "same" }] }]
    expect(historyHasSessionBlock(NO_SIDEBAND, h, "same")).toBe(true)
    expect(historyHasSessionBlock(NO_SIDEBAND, h, "other")).toBe(false)
  })
})

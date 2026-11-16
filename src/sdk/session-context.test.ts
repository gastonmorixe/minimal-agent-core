/**
 * Session context dedupe on resume: a block with the same wrapped text in
 * the current history gives no second block. Different text gives a new one.
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { Message } from "../llm/messages.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import { wrapHookContext } from "./hook-context.ts"
import { historyHasSessionBlock, SessionContextQueue } from "./session-context.ts"

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

describe("session context dedupe", () => {
  const block = wrapHookContext(["branch main"])
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
    const fresh = wrapHookContext(["branch dev"])
    expect(countBlocks(agent.messages, fresh)).toBe(1)
    expect(countBlocks(agent.messages, block)).toBe(1)
  })

  it("the queue take gives an empty text for a known block and empties the queue", () => {
    const q = new SessionContextQueue()
    q.add(["branch main"])
    expect(q.take(history)).toBe("")
    expect(q.take(history)).toBe("")
    q.add(["branch main"])
    expect(q.take([])).toBe(block)
    expect(historyHasSessionBlock(history, block)).toBe(true)
    expect(historyHasSessionBlock(history, wrapHookContext(["x"]))).toBe(false)
  })
})

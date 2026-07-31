/** Tests for Agent.noteSessionResumed() and its one-shot runtime attachment. */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { Message, SendOptions, StreamedResponse } from "../client/types.ts"

import { Agent } from "./agent.ts"

const auth: AuthResult = { type: "api-key", token: "test-token" }

function makeSendFn() {
  const calls: Array<{ messages: Message[] }> = []
  const sendFn = async function* (
    opts: SendOptions,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    calls.push({ messages: JSON.parse(JSON.stringify(opts.messages)) })
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
  return { calls, sendFn: sendFn as never }
}

async function drain(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<void> {
  while (!(await gen.next()).done) {}
}

function lastUserTextBlocks(messages: Message[]): string[] {
  const message = messages.filter((m) => m.role === "user").at(-1)
  if (!message || !Array.isArray(message.content)) return []
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
}

describe("Agent.noteSessionResumed", () => {
  it("adds a session-resumed attachment without an empty user-text block", async () => {
    const { calls, sendFn } = makeSendFn()
    const agent = new Agent({ auth, model: "test-model", sendFn })

    agent.noteSessionResumed()
    await drain(agent.run(""))

    expect(calls).toHaveLength(1)
    const blocks = lastUserTextBlocks(calls[0].messages)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain("<ma::agent::session-resumed />")
    expect(blocks).not.toContain("")
  })

  it("consumes the resume marker after one run", async () => {
    const { calls, sendFn } = makeSendFn()
    const agent = new Agent({ auth, model: "test-model", sendFn })

    agent.noteSessionResumed()
    await drain(agent.run(""))
    await drain(agent.run("next"))

    expect(lastUserTextBlocks(calls[0].messages).join("\n")).toContain("session-resumed")
    expect(lastUserTextBlocks(calls[1].messages).join("\n")).not.toContain("session-resumed")
  })
})

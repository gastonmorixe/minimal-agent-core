/**
 * Tests for Agent.notePreviousTurnAborted() and the model-visible
 * `<ma::agent::turn-aborted />` marker it injects into the next user turn.
 *
 * Pattern mirrors src/agent.test.ts and src/agent.abort-repl.test.ts:
 * construct a real Agent with a fake sendFn, drive run() to completion,
 * and inspect the messages the sendFn received.
 */

import { describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth/auth.ts"
import type { Message, SendOptions, StreamedResponse } from "./client/types.ts"

// ----------------------------- helpers -------------------------------------

const auth: AuthResult = { type: "api-key", token: "test-token" }

/**
 * Build a fake sendFn that records every call's messages snapshot and
 * immediately returns a benign end_turn response (no tool_use).
 */
function makeSendFn() {
  const calls: Array<{ messages: Message[] }> = []

  const sendFn = async function* (
    opts: SendOptions,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    // Deep-clone so later mutations to agent.messages don't affect what we recorded.
    calls.push({ messages: JSON.parse(JSON.stringify(opts.messages)) })
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }

  return { sendFn: sendFn as any, calls }
}

/** Drain an async generator fully. */
async function drain(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<void> {
  while (true) {
    const { done } = await gen.next()
    if (done) break
  }
}

/**
 * Return all text-block strings from the first user message in the given
 * messages array.
 */
function firstUserTextBlocks(messages: Message[]): string[] {
  const first = messages.find((m) => m.role === "user")
  if (!first) return []
  const content = Array.isArray(first.content) ? first.content : []
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
}

// ----------------------------- tests ---------------------------------------

describe("Agent.notePreviousTurnAborted()", () => {
  it("(a) injects turn-aborted marker in the next run() after notePreviousTurnAborted()", async () => {
    const { sendFn, calls } = makeSendFn()
    const agent = new Agent({ auth, model: "test-model", sendFn })

    agent.notePreviousTurnAborted()
    await drain(agent.run("hello"))

    expect(calls.length).toBe(1)
    const textBlocks = firstUserTextBlocks(calls[0].messages)
    const markerBlock = textBlocks.find((t) => t.includes("<ma::agent::turn-aborted />"))
    expect(markerBlock).toBeDefined()
  })

  it("(b) does NOT inject marker when notePreviousTurnAborted() was never called", async () => {
    const { sendFn, calls } = makeSendFn()
    const agent = new Agent({ auth, model: "test-model", sendFn })

    await drain(agent.run("hello"))

    expect(calls.length).toBe(1)
    const textBlocks = firstUserTextBlocks(calls[0].messages)
    const markerBlock = textBlocks.find((t) => t.includes("<ma::agent::turn-aborted />"))
    expect(markerBlock).toBeUndefined()
  })

  it("(c) flag is one-shot: marker appears on run() #1 but NOT on run() #2", async () => {
    const { sendFn, calls } = makeSendFn()
    const agent = new Agent({ auth, model: "test-model", sendFn })

    agent.notePreviousTurnAborted()

    // First run: marker should appear.
    await drain(agent.run("first"))
    expect(calls.length).toBe(1)
    const textBlocks1 = firstUserTextBlocks(calls[0].messages)
    expect(textBlocks1.find((t) => t.includes("<ma::agent::turn-aborted />"))).toBeDefined()

    // Second run (no second call to notePreviousTurnAborted): no marker.
    await drain(agent.run("second"))
    expect(calls.length).toBe(2)
    // The second call's messages include both turns. The second user message
    // is the last user message. Filter to only the last user message.
    const msgs2 = calls[1].messages
    const userMsgs2 = msgs2.filter((m) => m.role === "user")
    // Last user message is the "second" turn.
    const lastUserMsg = userMsgs2[userMsgs2.length - 1]
    const content2 = Array.isArray(lastUserMsg.content) ? lastUserMsg.content : []
    const textBlocks2 = content2
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
    expect(textBlocks2.find((t) => t.includes("<ma::agent::turn-aborted />"))).toBeUndefined()
  })

  it("(d) marker is a {type:'text'} block (not a tool_result)", async () => {
    const { sendFn, calls } = makeSendFn()
    const agent = new Agent({ auth, model: "test-model", sendFn })

    agent.notePreviousTurnAborted()
    await drain(agent.run("hello"))

    const firstMsg = calls[0].messages.find((m) => m.role === "user")
    expect(firstMsg).toBeDefined()
    const content = Array.isArray(firstMsg!.content) ? firstMsg!.content : []
    const markerBlockEntry = content.find(
      (b) =>
        b.type === "text" &&
        (b as { type: string; text: string }).text.includes("<ma::agent::turn-aborted />"),
    )
    expect(markerBlockEntry).toBeDefined()
    expect(markerBlockEntry!.type).toBe("text")
  })
})

/**
 * Tests for the generic `turnAttachments` extension point on `Agent.run`.
 *
 * `turnAttachments: Array<{toAttachment(): ContentBlock | null}>` are the open
 * slot for plugins (e.g. `sub-agents`) to surface live per-turn state without
 * the agent core knowing the producer's identity.
 *
 * Core-side seam test (Wave A unit A-4): this file exercises ONLY the
 * agent↔producer seam contract through in-test FAKE producers — it does
 * not import any plugin (invariant I2). The real `SubagentsAttachment`
 * (active → block; idle → omitted) is characterized in the plugin's own
 * suite (`plugins/sub-agents/lib/attachment.test.ts`).
 *
 * Invariants, mirroring the named `tasksAttachment` producer:
 *
 *   1. Injected AFTER tasks, BEFORE the user text, in array order.
 *   2. null-returning producers contribute nothing.
 *   3. Initial seam only (called once per run).
 */

import { describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth/auth.ts"
import type { ContentBlock, SendOptions, StreamedResponse } from "./client/types.ts"

const auth: AuthResult = { type: "api-key", token: "test" }

class FakeProducer {
  callCount = 0
  constructor(private value: ContentBlock | null) {}
  toAttachment(): ContentBlock | null {
    this.callCount += 1
    return this.value
  }
}

function makeTextSendFn(records: Array<Record<string, unknown>>) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

describe("Agent.run — generic turnAttachments", () => {
  it("injects producers after tasks, before user text, in order", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const tasks = new FakeProducer({ type: "text", text: "<ma::agent::tasks></ma::agent::tasks>" })
    const a = new FakeProducer({
      type: "text",
      text: "<ma::agent::subagents>A</ma::agent::subagents>",
    })
    const b = new FakeProducer({ type: "text", text: "<ma::agent::other>B</ma::agent::other>" })
    const agent = new Agent({
      auth,
      model: "test",
      sendFn,
      tasksAttachment: tasks,
      turnAttachments: [a, b],
    })

    for await (const _ of agent.run("hi")) {
      // drain
    }

    const messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
    const content = messages[0]?.content ?? []
    expect(content.length).toBe(4)
    expect((content[0] as { text: string }).text).toContain("<ma::agent::tasks")
    expect((content[1] as { text: string }).text).toContain("<ma::agent::subagents>")
    expect((content[2] as { text: string }).text).toContain("<ma::agent::other>")
    expect((content[3] as { text: string }).text).toBe("hi")
  })

  it("skips null-returning producers (zero token cost when idle)", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const a = new FakeProducer(null)
    const agent = new Agent({ auth, model: "test", sendFn, turnAttachments: [a] })

    for await (const _ of agent.run("hi")) {
      // drain
    }

    const messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
    const content = messages[0]?.content ?? []
    expect(content.length).toBe(1)
    expect((content[0] as { text: string }).text).toBe("hi")
    expect(a.callCount).toBe(1) // called once at the initial seam
  })
})

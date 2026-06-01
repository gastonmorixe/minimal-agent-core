/**
 * Tests for the generic `turnAttachments` extension point on `Agent.run`.
 *
 * `turnAttachments: Array<{toAttachment(): ContentBlock | null}>` are the open
 * slot for plugins (e.g. `sub-agents`) to surface live per-turn state without
 * the agent core knowing the producer's identity. Invariants mirror the named
 * `tasksAttachment` producer:
 *
 *   1. Injected AFTER tasks, BEFORE the user text, in array order.
 *   2. null-returning producers contribute nothing.
 *   3. Initial seam only (not re-emitted post tool_use).
 *   4. End-to-end with the real SubagentsAttachment (active → block; idle → omitted).
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { SubagentsAttachment } from "../plugins/sub-agents/lib/attachment.ts"
import { SubagentStore } from "../plugins/sub-agents/lib/store.ts"
import { sessionId, subagentId } from "../plugins/sub-agents/lib/types.ts"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { ContentBlock, SendOptions, StreamedResponse } from "./client.ts"

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

describe("Agent.run — real SubagentsAttachment integration", () => {
  let dir: string
  const sid = "lead-turn-attach-sid"
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-subagents-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("surfaces the fleet when a worker is active", async () => {
    const store = new SubagentStore(sid, { dir })
    store.upsert({
      id: subagentId("A1"),
      sid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
      label: "worker",
      type: "worker",
      model: "claude-haiku-4-5",
      task: "t",
      isolation: "fresh",
      workspace: "inherit-cwd",
      spawnedAt: "2026-05-30T11:59:00.000Z",
      status: {
        kind: "running",
        pid: 1,
        startedAt: "2026-05-30T11:59:00.000Z",
        progress: { tools: 0, tokens: 0 },
      },
      depth: 1,
      leadSid: sessionId("11111111-1111-4111-8111-111111111111"),
    })

    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const agent = new Agent({
      auth,
      model: "test",
      sendFn,
      turnAttachments: [new SubagentsAttachment(sid, { dir })],
    })

    for await (const _ of agent.run("status?")) {
      // drain
    }

    const messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
    const content = messages[0]?.content ?? []
    expect(content.length).toBe(2)
    expect((content[0] as { text: string }).text).toContain("<ma::agent::subagents")
    expect((content[0] as { text: string }).text).toContain("A1")
  })

  it("omits the block when no worker is active", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const agent = new Agent({
      auth,
      model: "test",
      sendFn,
      turnAttachments: [new SubagentsAttachment(sid, { dir })],
    })

    for await (const _ of agent.run("hi")) {
      // drain
    }

    const messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
    const content = messages[0]?.content ?? []
    expect(content.length).toBe(1)
    expect((content[0] as { text: string }).text).toBe("hi")
  })
})

/**
 * Tests for the generic `turnAttachments` extension point on `AgentCore.run`.
 *
 * `turnAttachments: Array<{toAttachment(): ContentBlock | null}>` are the open
 * slot for plugins (e.g. `sub-agents`) to surface live per-turn state without
 * the core knowing the producer's identity. In the product (`src/index.ts`)
 * every producer, tasks included, reaches `buildAgentCore({ turnAttachments })`
 * through the registry (`instantiateTurnAttachments`), ordered by manifest
 * `order`; {@link wireTurnAttachments} replays that path with in-test fakes.
 *
 * Core-side seam test (Wave A unit A-4): this file exercises ONLY the
 * core↔producer seam contract through in-test FAKE producers — it does
 * not import any plugin (invariant I2). The real `SubagentsAttachment`
 * (active → block; idle → omitted) is characterized in the plugin's own
 * suite (`plugins/sub-agents/lib/attachment.test.ts`).
 *
 * Invariants, mirroring the tasks producer:
 *
 *   1. Injected AFTER tasks, BEFORE the user text, in array order.
 *   2. null-returning producers contribute nothing.
 *   3. Initial seam only (called once per run).
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { ContentBlock, SendOptions, StreamedResponse } from "../client/types.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

import {
  clearTurnAttachmentFactories,
  instantiateTurnAttachments,
  registerTurnAttachmentFactory,
  type TurnAttachmentProducer,
} from "./turn-attachments.ts"

const auth: AuthResult = { type: "api-key", token: "test" }

class FakeProducer {
  callCount = 0
  constructor(private value: ContentBlock | null) {}
  toAttachment(): ContentBlock | null {
    this.callCount += 1
    return this.value
  }
}

/**
 * Wire the fakes into AgentCore exactly as `src/index.ts` does: register each
 * producer in the turn-attachment registry, instantiate it, and return the
 * `turnAttachments` dep `buildAgentCore` receives. The tasks fake takes the
 * tasks plugin's manifest key + order (`ma-tasks-plugin/manifest.json`:
 * `tasks_snapshot` order 20). Generic producers take the registry default
 * order (100), so they sort after tasks and keep their array order through the
 * registration sequence. They are registered BEFORE tasks on purpose, so the
 * tasks-first order comes from the manifest order, not call order. The
 * registry is module-level, so it is cleared on both sides.
 */
async function wireTurnAttachments(fakes: {
  tasksAttachment?: TurnAttachmentProducer
  turnAttachments?: TurnAttachmentProducer[]
}): Promise<{ turnAttachments: TurnAttachmentProducer[] }> {
  clearTurnAttachmentFactories()
  const { tasksAttachment, turnAttachments = [] } = fakes
  turnAttachments.forEach((producer, i) => {
    registerTurnAttachmentFactory(`plugin-${i}/attachment`, () => producer)
  })
  if (tasksAttachment) {
    registerTurnAttachmentFactory("tasks/tasks_snapshot", () => tasksAttachment, { order: 20 })
  }
  const { producers } = await instantiateTurnAttachments({ sessionId: null })
  clearTurnAttachmentFactories()
  return { turnAttachments: producers }
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

describe("AgentCore.run — generic turnAttachments", () => {
  it("injects producers after tasks, before user text, in order", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const tasks = new FakeProducer({ type: "text", text: "<ma::agent::tasks></ma::agent::tasks>" })
    const a = new FakeProducer({
      type: "text",
      text: "<ma::agent::subagents>A</ma::agent::subagents>",
    })
    const b = new FakeProducer({ type: "text", text: "<ma::agent::other>B</ma::agent::other>" })
    const agent = await buildTestCore({
      auth,
      model: "test",
      sendFn,
      ...(await wireTurnAttachments({ tasksAttachment: tasks, turnAttachments: [a, b] })),
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
    const agent = await buildTestCore({
      auth,
      model: "test",
      sendFn,
      ...(await wireTurnAttachments({ turnAttachments: [a] })),
    })

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

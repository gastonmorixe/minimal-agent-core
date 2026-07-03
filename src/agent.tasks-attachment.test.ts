/**
 * Tests for the tasks-plugin attachment wiring in `Agent.run`.
 *
 * Covers the optional injectable on the Agent constructor:
 *
 *   - `tasksAttachment` — `{toAttachment(): ContentBlock | null}` called
 *     once at the INITIAL user-message seam only; produces a
 *     `<ma::agent::tasks …>…</ma::agent::tasks>` block.
 *
 * Core-side seam test (Wave A unit A-4): this file exercises ONLY the
 * agent↔producer seam contract through in-test FAKE producers — it does
 * not import the tasks plugin (invariant I2). The real `TasksAttachment`
 * class wired through a `TaskStore` is characterized in the plugin's own
 * suite (`plugins/tasks/lib/attachment.test.ts`).
 *
 * Structurally identical to `shortTermSnapshot` (see
 * `agent.memory-attachments.test.ts`) so the assertions here mirror that
 * file closely. Key invariants:
 *
 *   1. Zero-regression: with no `tasksAttachment`, message shape is
 *      unchanged (`[text]` only).
 *   2. Attachment alone: prepended BEFORE user text.
 *   3. Tasks comes AFTER ma::agent::short-term-memory but BEFORE save-echoes (the
 *      ORDER NOTE in agent.ts spells out the rationale).
 *   4. With mode-change too: mode-change FIRST, then STM, then tasks,
 *      then save-echoes.
 *   5. Loop seam (post tool_use): tasks NOT re-emitted (would balloon
 *      context with stale repeats — same rule STM follows).
 *   6. `toAttachment()` is called exactly once per `run()` (initial
 *      seam only).
 */

import { describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth/auth.ts"
import type { ContentBlock, SendOptions, StreamedResponse } from "./client/types.ts"

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

class FakeTasksAttachment {
  callCount = 0
  constructor(private value: ContentBlock | null) {}
  toAttachment(): ContentBlock | null {
    this.callCount += 1
    return this.value
  }
}

class FakeSnapshot {
  constructor(private value: ContentBlock | null) {}
  toAttachment(): ContentBlock | null {
    return this.value
  }
}

class FakeSaveEcho {
  private queue: ContentBlock[] = []
  enqueue(block: ContentBlock): void {
    this.queue.push(block)
  }
  consumeAll(): ContentBlock[] {
    if (this.queue.length === 0) return []
    const out = this.queue
    this.queue = []
    return out
  }
}

// ---------------------------------------------------------------------------
// sendFn factories (mirror agent.memory-attachments.test.ts)
// ---------------------------------------------------------------------------

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

function makeRecordingSendFnWithToolUse(records: Array<Record<string, unknown>>) {
  let round = 0
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
    round += 1
    if (round === 1) {
      return {
        blocks: [
          {
            type: "tool_use" as const,
            id: "call-1",
            name: "Bash",
            input: { command: "echo hi" },
          },
        ],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

const auth: AuthResult = { type: "api-key", token: "test" }

// ---------------------------------------------------------------------------
// (1) Zero-regression baseline
// ---------------------------------------------------------------------------

describe("Agent.run — tasks attachment (zero-regression baseline)", () => {
  it("with no tasksAttachment, initial user content is unchanged", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const agent = new Agent({ auth, model: "test", sendFn })

    for await (const _ of agent.run("hi")) {
      // drain
    }

    const messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
    const content = messages[0]?.content ?? []
    expect(content.length).toBe(1)
    expect(content[0]?.type).toBe("text")
    expect((content[0] as { text: string }).text).toBe("hi")
  })

  it("with tasksAttachment returning null, no extra block is injected", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const tasks = new FakeTasksAttachment(null)
    const agent = new Agent({ auth, model: "test", sendFn, tasksAttachment: tasks })

    for await (const _ of agent.run("hi")) {
      // drain
    }

    const messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
    const content = messages[0]?.content ?? []
    expect(content.length).toBe(1)
    expect((content[0] as { text: string }).text).toBe("hi")
    expect(tasks.callCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// (2) Attachment alone at initial seam
// ---------------------------------------------------------------------------

describe("Agent.run — tasks attachment (initial seam)", () => {
  it("prepends the tasks attachment when present", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const tasks = new FakeTasksAttachment({
      type: "text",
      text: '<ma::agent::tasks total="1" done="0" doing="0" todo="1" canceled="0">\n1  #a7b3c4  todo  hello\n</ma::agent::tasks>',
    })
    const agent = new Agent({ auth, model: "test", sendFn, tasksAttachment: tasks })

    for await (const _ of agent.run("hi")) {
      // drain
    }

    const messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
    const content = messages[0]?.content ?? []
    expect(content.length).toBe(2)
    expect((content[0] as { text: string }).text).toContain("<ma::agent::tasks")
    expect((content[0] as { text: string }).text).toContain("hello")
    expect((content[1] as { text: string }).text).toBe("hi")
  })
})

// ---------------------------------------------------------------------------
// (3) Order with ma::agent::short-term-memory: STM first, then tasks
// ---------------------------------------------------------------------------

describe("Agent.run — tasks attachment (combined order)", () => {
  it("places ma::agent::short-term-memory BEFORE tasks (STM is ambient, tasks is structured plan)", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const stm = new FakeSnapshot({
      type: "text",
      text: "<ma::agent::short-term-memory>\n[#1] hypothesis: X\n</ma::agent::short-term-memory>",
    })
    const tasks = new FakeTasksAttachment({
      type: "text",
      text: '<ma::agent::tasks total="1" done="0" doing="0" todo="1" canceled="0">\n1  #a7b3c4  todo  step\n</ma::agent::tasks>',
    })
    const agent = new Agent({
      auth,
      model: "test",
      sendFn,
      shortTermSnapshot: stm,
      tasksAttachment: tasks,
    })

    for await (const _ of agent.run("hi")) {
      // drain
    }

    const messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
    const content = messages[0]?.content ?? []
    expect(content.length).toBe(3)
    expect((content[0] as { text: string }).text).toContain("<ma::agent::short-term-memory>")
    expect((content[1] as { text: string }).text).toContain("<ma::agent::tasks")
    expect((content[2] as { text: string }).text).toBe("hi")
  })

  it("places tasks BEFORE save-echoes (echoes are deltas, tasks is persistent state)", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const tasks = new FakeTasksAttachment({
      type: "text",
      text: '<ma::agent::tasks total="0" done="0" doing="0" todo="0" canceled="0">\n</ma::agent::tasks>',
    })
    const echoes = new FakeSaveEcho()
    echoes.enqueue({
      type: "text",
      text: '<ma::agent::memory-saved scope="project" id="abc">prev</ma::agent::memory-saved>',
    })
    const agent = new Agent({
      auth,
      model: "test",
      sendFn,
      tasksAttachment: tasks,
      saveEcho: echoes,
    })

    for await (const _ of agent.run("hi")) {
      // drain
    }

    const messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
    const content = messages[0]?.content ?? []
    expect(content.length).toBe(3)
    expect((content[0] as { text: string }).text).toContain("<ma::agent::tasks")
    expect((content[1] as { text: string }).text).toContain("<ma::agent::memory-saved")
    expect((content[2] as { text: string }).text).toBe("hi")
  })

  it("full stack: mode → STM → tasks → echoes → user", async () => {
    const { ModeManager } = await import("./modes/modes.ts")
    const modeManager = new ModeManager([{ id: "ask", label: "ASK", disallowedTools: [] }], "ask")

    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const stm = new FakeSnapshot({
      type: "text",
      text: "<ma::agent::short-term-memory>\n[#1] x\n</ma::agent::short-term-memory>",
    })
    const tasks = new FakeTasksAttachment({
      type: "text",
      text: '<ma::agent::tasks total="1" done="0" doing="0" todo="1" canceled="0">\n1  #a7b3c4  todo  go\n</ma::agent::tasks>',
    })
    const echoes = new FakeSaveEcho()
    echoes.enqueue({
      type: "text",
      text: '<ma::agent::memory-saved scope="project" id="abc">p</ma::agent::memory-saved>',
    })
    const agent = new Agent({
      auth,
      model: "test",
      sendFn,
      modeManager,
      shortTermSnapshot: stm,
      tasksAttachment: tasks,
      saveEcho: echoes,
    })

    for await (const _ of agent.run("hi")) {
      // drain
    }

    const messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
    const content = messages[0]?.content ?? []
    expect(content.length).toBe(5)
    expect((content[0] as { text: string }).text).toContain("<ma::agent::mode-change")
    expect((content[1] as { text: string }).text).toContain("<ma::agent::short-term-memory>")
    expect((content[2] as { text: string }).text).toContain("<ma::agent::tasks")
    expect((content[3] as { text: string }).text).toContain("<ma::agent::memory-saved")
    expect((content[4] as { text: string }).text).toBe("hi")
  })
})

// ---------------------------------------------------------------------------
// (4) Loop seam: tasks NOT re-emitted
// ---------------------------------------------------------------------------

describe("Agent.run — tasks attachment (loop seam)", () => {
  it("does NOT re-emit the tasks attachment on the post-tool_use seam", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeRecordingSendFnWithToolUse(records)
    const tasks = new FakeTasksAttachment({
      type: "text",
      text: '<ma::agent::tasks total="1" done="0" doing="0" todo="1" canceled="0">\n1  #a7b3c4  todo  step\n</ma::agent::tasks>',
    })
    const agent = new Agent({ auth, model: "test", sendFn, tasksAttachment: tasks })

    for await (const _ of agent.run("hi")) {
      // drain
    }

    // Two rounds captured. The tasks attachment is on round 1 only.
    expect(records.length).toBe(2)

    const round2Messages = records[1]?.messages as Array<{
      role: string
      content: ContentBlock[]
    }>
    // [user(initial), assistant(tool_use), user(tool_result + …)]
    expect(round2Messages.length).toBe(3)
    const round2User = round2Messages[2]?.content ?? []
    // First block of the loop-seam user message is the tool_result (API
    // contract — would 400 otherwise). No tasks attachment in there.
    expect(round2User[0]?.type).toBe("tool_result")
    const textBlocks = round2User
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
    for (const t of textBlocks) {
      expect(t).not.toContain("<ma::agent::tasks")
    }

    // toAttachment must have been called exactly ONCE (initial seam only).
    expect(tasks.callCount).toBe(1)
  })
})

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { ContentBlock, Message, SendOptions, StreamedResponse } from "../client/types.ts"
import { PluginLoader } from "../plugins/loader.ts"

import { Agent } from "./agent.ts"

const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

describe("Agent.run transcript", () => {
  it("writes tool header and tool result preview via opts.onTranscriptLine", async () => {
    let round = 0
    const sendFn = async function* () {
      round++
      if (round === 1) {
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "call-1",
              name: "NonExistentTool",
              input: {},
            },
          ],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test-token" }
    const agent = new Agent({ auth, model: "test-model", sendFn })

    const transcript: string[] = []
    const gen = agent.run("go", {
      onTranscriptLine: (line: string) => transcript.push(line),
    })

    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const joined = transcript.join("\n")
    expect(joined).toContain("NonExistentTool")
    expect(joined).toContain("Unknown tool")
  })

  it("applies reflection-ack silence when flash model emits it as a tool_use", async () => {
    // Flash/small models confuse the inline XML tag for a tool call.
    // The agent loop should parse the tool_use input, apply the silence,
    // and return a success result (not "Unknown tool").
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "call-ack-1",
              name: "reflection-ack",
              input: { "silence-for": "3", reason: "batch refactor" },
            },
          ],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test-token" }
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn,
      reflectionInterval: 50,
      reflectionCooldownMs: 0,
    })

    const transcript: string[] = []
    const gen = agent.run("go", {
      onTranscriptLine: (line: string) => transcript.push(line),
    })

    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const joined = transcript.join("\n")
    expect(joined).toContain("reflection-ack")
    expect(joined).toContain(
      "reflection ack: silencing next 3 checkpoints — batch refactor (from tool_use fallback)",
    )
    expect(joined).not.toContain("Unknown tool")
  })

  it("renders Task plugin header and footer through the host tool frame", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "task-transcript-test-"))
    const oldHome = process.env.HOME
    try {
      process.env.HOME = tmpHome
      const loader = await PluginLoader.load({
        embeddedDir: resolve(__dirname, ".."),
        coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
        sessionId: "99999999-aaaa-bbbb-cccc-dddddddddddd",
      })
      let round = 0
      const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        round++
        if (round === 1) {
          return {
            blocks: [
              {
                type: "tool_use" as const,
                id: "tu-task",
                name: "Task",
                input: { action: "add_many", titles: ["Verify lint clean", "Run tests"] },
              },
            ],
            text: "",
            stopReason: "tool_use",
          } as StreamedResponse
        }
        yield "done"
        return {
          blocks: [{ type: "text" as const, text: "done" }],
          text: "done",
          stopReason: "end_turn",
        } as StreamedResponse
      }

      const agent = new Agent({
        auth: { type: "api-key", token: "test-token" },
        model: "test-model",
        loader,
        sendFn,
      })
      const transcript: string[] = []
      for await (const _ of agent.run("go", {
        onTranscriptLine: (line) => transcript.push(line),
      })) {
        // drain
      }
      const plain = stripAnsi(transcript.join("\n"))
      // Manifest-owned chrome (`✔ Task` from icon+name) followed by the
      // plugin's header content slot (action verb + stats). The plugin no
      // longer prepends its own `○ Tasks` brand — that lived inside the
      // host frame and would shadow the manifest identity.
      expect(plain).toContain("  ╭ ✔ Task  + added 2 tasks · 0/2")
      expect(plain).toContain("  │    1  ○")
      expect(plain).toContain("Verify lint clean")
      expect(plain).toContain("  ╰  0 done · 0 doing · 2 todo")
      expect(plain).not.toContain("  │ ╭")
      expect(plain).not.toContain("  │ │")
    } finally {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("appends a streak `[note: ...]` to tool_result.content after 3 consecutive truncations", async () => {
    // Layer 3 (feedback tracker) integration test. Wires into executeTool's
    // real path: each round emits a Bash tool_use whose command produces
    // > 64KB of output, hits the universal clamp, and increments the
    // tracker. The 3rd hit fires the streak note. We inspect the 4th
    // request's last user message to find the tool_result content
    // carrying that note.
    const records: Array<Record<string, unknown>> = []
    let round = 0
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      round++
      if (round <= 3) {
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: `call-${round}`,
              name: "Bash",
              // 200KB of output → universal clamp at 64KB fires.
              input: { command: "yes hi | head -c 200000" },
            },
          ],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test-token" }
    const agent = new Agent({ auth, model: "test-model", sendFn })

    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // Round 4 (last) carries the cumulative history including all 3
    // tool_results. The 3rd tool_result is the one that triggered the
    // streak note.
    expect(records.length).toBe(4)
    const round4Msgs = records[3].messages as Array<Record<string, unknown>>
    // Find every tool_result content from the user messages.
    const allToolResultContent: string[] = []
    for (const msg of round4Msgs) {
      if (msg.role !== "user") continue
      const blocks = msg.content as Array<Record<string, unknown>>
      for (const b of blocks) {
        if (b.type === "tool_result") allToolResultContent.push(String(b.content))
      }
    }
    // Three Bash truncations → exactly one streak note appended to the third.
    const withNote = allToolResultContent.filter((s) => s.includes("[note:"))
    expect(withNote.length).toBe(1)
    expect(withNote[0]).toContain("[truncated:") // both notices present
    expect(withNote[0]).toContain("[note:")
    expect(withNote[0]).toMatch(/3 Bash calls in a row/)
  }, 30_000)

  it("forwards opts.signal to sendFn so the transport can be torn down", async () => {
    let captured: SendOptions | null = null
    const sendFn = async function* (opts: SendOptions) {
      captured = opts
      yield "hi"
      return {
        blocks: [{ type: "text" as const, text: "hi" }],
        text: "hi",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const auth: AuthResult = { type: "api-key", token: "test-token" }
    const agent = new Agent({ auth, model: "test-model", sendFn })
    const ac = new AbortController()
    const gen = agent.run("go", { signal: ac.signal })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }
    const seen = captured as SendOptions | null
    if (!seen) throw new Error("sendFn was not called")
    expect(seen.signal).toBe(ac.signal)
  })

  it("throws AbortError between rounds when signal fires after a tool result", async () => {
    // Round 1 yields a chunk (so the consumer pauses there), then returns
    // a tool_use. The consumer aborts while paused on the yield. After
    // resuming, the agent executes the tool then loops to round 2 — at
    // which point the top-of-loop signal check must fire, throwing
    // AbortError without ever calling sendFn a second time.
    let round = 0
    let secondRoundCalled = false
    const ac = new AbortController()
    const sendFn = async function* () {
      round++
      if (round === 1) {
        yield "preamble"
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "call-1",
              name: "NonExistentTool",
              input: {},
            },
          ],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      secondRoundCalled = true
      return {
        blocks: [],
        text: "",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const auth: AuthResult = { type: "api-key", token: "test-token" }
    const agent = new Agent({ auth, model: "test-model", sendFn })
    const gen = agent.run("go", {
      signal: ac.signal,
      onTranscriptLine: () => {},
    })
    // First `next()` returns the "preamble" yield; we're now paused with
    // round 1 mid-execution. Abort here.
    const first = await gen.next()
    expect(first.value).toBe("preamble")
    ac.abort()
    let err: unknown = null
    try {
      while (true) {
        const { done } = await gen.next()
        if (done) break
      }
    } catch (e) {
      err = e
    }
    expect(err).not.toBeNull()
    expect((err as { name?: string }).name).toBe("AbortError")
    expect(secondRoundCalled).toBe(false)
  })
})

describe("Agent.run coalesces onto a trailing user message (resume after force-quit)", () => {
  // Resume state: the prior turn ran a tool, the result came back, but the
  // assistant continuation never streamed (force-quit). extractPendingDraft
  // pulled the un-replied prompt into the editor, leaving the history ending
  // in `assistant(tool_use) → user([tool_result])`. Submitting the draft must
  // NOT produce a `[user, user]` pair (the API rejects "roles must alternate").
  it("merges the new turn into a trailing user([tool_result]) instead of appending [user, user]", async () => {
    const initialMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "kick off" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } } as ContentBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "ok",
            is_error: false,
          } as ContentBlock,
        ],
      },
    ]

    let captured: SendOptions | null = null
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      captured = JSON.parse(JSON.stringify({ messages: opts.messages })) as SendOptions
      yield "ok"
      return {
        blocks: [{ type: "text", text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test-token" }
    const agent = new Agent({ auth, model: "test-model", sendFn, initialMessages })

    const gen = agent.run("the resumed draft")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const sent = (captured as unknown as { messages: Message[] }).messages
    // No two consecutive user messages anywhere.
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i].role === "user" && sent[i - 1].role === "user").toBe(false)
    }
    // The trailing user message carries BOTH the tool_result (preserved) and
    // the resumed draft text, tool_result first.
    const tail = sent[sent.length - 1]
    expect(tail.role).toBe("user")
    const blocks = tail.content as Array<{ type: string; text?: string }>
    expect(blocks[0].type).toBe("tool_result")
    expect(blocks.some((b) => b.type === "text" && b.text === "the resumed draft")).toBe(true)
    // And the live messages array on the agent matches what was sent (no
    // dangling consecutive users left behind).
    expect(agent.messages.filter((m) => m.role === "user").length).toBeLessThan(sent.length)
  })

  // The ordinary case is unaffected: when the prior turn ended on an
  // assistant message, a new submit appends a fresh user message.
  it("appends a fresh user message when the last message is an assistant turn", async () => {
    const initialMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    let captured: SendOptions | null = null
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      captured = JSON.parse(JSON.stringify({ messages: opts.messages })) as SendOptions
      yield "ok"
      return {
        blocks: [{ type: "text", text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const auth: AuthResult = { type: "api-key", token: "test-token" }
    const agent = new Agent({ auth, model: "test-model", sendFn, initialMessages })
    const gen = agent.run("next question")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }
    const sent = (captured as unknown as { messages: Message[] }).messages
    expect(sent).toHaveLength(3)
    expect(sent[2].role).toBe("user")
    const blocks = sent[2].content as Array<{ type: string; text?: string }>
    expect(blocks.some((b) => b.type === "text" && b.text === "next question")).toBe(true)
  })
})

describe("Agent + SessionStore", () => {
  it("persists user, assistant, and tool_result records across a full run", async () => {
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { SessionStore } = await import("../session/session-store.ts")
    const { loadSession } = await import("../session/session-restore.ts")

    let round = 0
    const sendFn = async function* () {
      round++
      if (round === 1) {
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "call-1",
              name: "NonExistentTool",
              input: {},
            },
          ],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const dir = mkdtempSync(join(tmpdir(), "ma-agent-store-"))
    const store = SessionStore.open({
      sid: "ma-agent-int",
      model: "test-model",
      cwd: "/tmp/x",
      systemHash: "h",
      toolsHash: "h",
      agentVersion: "test",
      dir,
    })

    const auth: AuthResult = { type: "api-key", token: "test-token" }
    const agent = new Agent({ auth, model: "test-model", sendFn, store })

    const gen = agent.run("go", { onTranscriptLine: () => {} })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const loaded = loadSession("ma-agent-int", dir)
    // Records: meta + user + assistant(tool_use) + tool_result + assistant(text)
    expect(loaded.records).toHaveLength(5)
    expect(loaded.records[0].kind).toBe("meta")
    expect(loaded.records[1].kind).toBe("user")
    expect(loaded.records[2].kind).toBe("assistant")
    expect(loaded.records[3].kind).toBe("tool_result")
    expect(loaded.records[4].kind).toBe("assistant")
    // No repair needed for a clean run.
    expect(loaded.repaired).toBe(false)
    expect(loaded.messages).toHaveLength(4)
  })

  it("seeds messages from initialMessages on construction (resume path)", () => {
    const auth: AuthResult = { type: "api-key", token: "test-token" }
    const agent = new Agent({
      auth,
      model: "test-model",
      initialMessages: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    })
    expect(agent.messages).toHaveLength(2)
    expect(agent.messages[0].content).toBe("earlier")
  })
})

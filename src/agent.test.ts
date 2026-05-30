import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "bun:test"

import { Agent, type ReplAgentLike, runRepl, withRollingCacheBreakpoint } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { ContentBlock, Message, SendOptions, StreamedResponse } from "./client.ts"
import { PluginLoader } from "./plugins/loader.ts"
import { StatusBus } from "./status.ts"

const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

class FakeInput {
  private readonly values: Array<string | null>

  constructor(values: Array<string | null>) {
    this.values = [...values]
  }

  async read(): Promise<string | null> {
    return this.values.shift() ?? null
  }
}

class FakeOutput {
  isTTY = false
  readonly chunks: string[] = []

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }

  text(): string {
    return this.chunks.join("")
  }
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

function makeAgent(
  chunks: string[],
  calls: string[],
  thinkingChunks: string[] = [],
): ReplAgentLike {
  return {
    pluginLoader: () => null,
    async *run(
      userText: string,
      opts?: {
        onTranscriptLine?: (line: string) => void
        onThinkingStart?: () => void | Promise<void>
        onThinkingChunk?: (chunk: string) => void | Promise<void>
        onThinkingStop?: () => void | Promise<void>
      },
    ) {
      calls.push(userText)
      if (thinkingChunks.length > 0) {
        await opts?.onThinkingStart?.()
        for (const chunk of thinkingChunks) {
          await opts?.onThinkingChunk?.(chunk)
        }
        await opts?.onThinkingStop?.()
      }
      for (const chunk of chunks) {
        yield chunk
      }
      return { blocks: [], text: chunks.join(""), stopReason: "end_turn" }
    },
  }
}

describe("runRepl", () => {
  it("ignores blank turns and omits turn separators", async () => {
    const calls: string[] = []
    const input = new FakeInput(["", "hello", null])
    const output = new FakeOutput()

    await runRepl(makeAgent(["Reply"], calls), {
      input,
      output,
      statusBus: new StatusBus(),
    })

    const text = stripAnsi(output.text())
    expect(calls).toEqual(["hello"])
    // The "ctrl+c quit" hint banner used to be emitted from runRepl
    // itself, but moved to `src/index.ts` (May 2026) so it lands above
    // resume replay rather than below it. The banner string lives in
    // `src/ready-banner.ts`; its content has its own unit test.
    expect(text).not.toContain("^D")
    expect(text).not.toContain("clear")
    expect(text).not.toContain("────────────────")
    // Final farewell present after the response.
    expect(text).toMatch(/Reply\n+Goodbye\./)
  })

  it("renders native thinking chunks through the formatter in faint output", async () => {
    const calls: string[] = []
    const output = new FakeOutput()
    const formatterCmd = [
      "bun",
      "-e",
      "let s = ''; const d = new TextDecoder(); for await (const chunk of Bun.stdin.stream()) s += d.decode(chunk); process.stdout.write('FMT[' + s.trimEnd() + ']\\n')",
    ]

    await runRepl(makeAgent(["Answer"], calls, ["# plan\n"]), {
      input: new FakeInput(["hello", null]),
      output,
      statusBus: new StatusBus(),
      formatterCmd,
    })

    const rendered = output.text()
    expect(calls).toEqual(["hello"])
    expect(rendered).toContain("\x1b[2mFMT[# plan]\x1b[22m\n")
    expect(rendered).toContain("FMT[Answer]")
  })

  it("does not add an extra blank line when the response already ends with one", async () => {
    const output = new FakeOutput()

    await runRepl(makeAgent(["Reply\n"], []), {
      input: new FakeInput(["hello", null]),
      output,
      statusBus: new StatusBus(),
    })

    const text = stripAnsi(output.text())
    // Response already ends with \n; the REPL must not double-blank it.
    expect(text).not.toContain("Reply\n\n\n\nGoodbye.")
    expect(text).toMatch(/Reply\n+Goodbye\./)
  })

  it("wraps agent transcript writes with statusRenderer suspend + errOutput + resume", async () => {
    const events: string[] = []

    const spyRenderer = {
      start(): void {
        events.push("start")
      },
      stop(): void {
        events.push("stop")
      },
      suspend(): void {
        events.push("suspend")
      },
      resume(): void {
        events.push("resume")
      },
    }

    const errOutput = {
      write(chunk: string | Uint8Array): boolean {
        const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
        events.push(`err:${s}`)
        return true
      },
    }

    const transcriptLine = "  ┌ Bash  $ ls"
    const fake: ReplAgentLike = {
      pluginLoader: () => null,
      async *run(_userText: string, opts?: { onTranscriptLine?: (line: string) => void }) {
        opts?.onTranscriptLine?.(transcriptLine)
        return {
          blocks: [],
          text: "",
          stopReason: "end_turn",
        } as StreamedResponse
      },
    }

    await runRepl(fake, {
      input: new FakeInput(["go", null]),
      output: new FakeOutput(),
      statusBus: new StatusBus(),
      statusRenderer: spyRenderer,
      errOutput,
    })

    const suspendIdx = events.indexOf("suspend")
    const writeIdx = events.indexOf(`err:${transcriptLine}\n`)
    const resumeIdx = events.indexOf("resume", suspendIdx + 1)

    expect(suspendIdx).toBeGreaterThanOrEqual(0)
    expect(writeIdx).toBeGreaterThan(suspendIdx)
    expect(resumeIdx).toBeGreaterThan(writeIdx)
  })
})

// ---------------------------------------------------------------------------
// Live-area path (Compositor + EditorController)
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events"

class FakeCompositor {
  readonly streams: string[] = []
  readonly liveAreas: Array<{
    lines: string[]
    cursor: { row: number; col: number } | null
  }> = []
  liveHeight = 1
  mounted = false
  unmounted = false
  mount(_n: number): void {
    this.mounted = true
  }
  unmount(): void {
    this.unmounted = true
  }
  setLiveArea(lines: string[], cursor: { row: number; col: number } | null): void {
    this.liveAreas.push({ lines: [...lines], cursor: cursor ? { ...cursor } : null })
  }
  setLiveHeight(n: number): void {
    this.liveHeight = n
  }
  writeStream(chunk: string): void {
    this.streams.push(chunk)
  }
  async withSuspendedLiveArea<T>(fn: () => Promise<T>): Promise<T> {
    return await fn()
  }
}

class FakeEditor extends EventEmitter {
  started = false
  stopped = false
  start(): void {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
  // helper for tests
  type(text: string): void {
    this.emit("submit", text)
  }
  cancel(): void {
    this.emit("cancel")
  }
}

describe("runRepl (live-area path)", () => {
  it("routes streamed chunks through compositor.writeStream and keeps editor alive across turns", async () => {
    const calls: string[] = []
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()

    const replPromise = runRepl(makeAgent(["hello ", "world"], calls), {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    // Drive two turns then cancel.
    await Promise.resolve()
    editor.type("first")
    // Allow the agent loop to run the generator to completion.
    await new Promise((r) => setTimeout(r, 5))
    editor.type("second")
    await new Promise((r) => setTimeout(r, 5))
    editor.cancel()
    await replPromise

    expect(calls).toEqual(["first", "second"])
    // Each chunk must have been written through the compositor.
    expect(compositor.streams).toContain("hello ")
    expect(compositor.streams).toContain("world")
    // Editor was started exactly once and stopped on shutdown.
    expect(editor.started).toBe(true)
    expect(editor.stopped).toBe(true)
    // Compositor was mounted and unmounted.
    expect(compositor.mounted).toBe(true)
    expect(compositor.unmounted).toBe(true)
  })

  it("transcript lines also flow through compositor.writeStream (above the live area)", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()
    const transcript = "  ┌ Bash  $ ls"

    const fake: ReplAgentLike = {
      pluginLoader: () => null,
      async *run(_t: string, opts?: { onTranscriptLine?: (line: string) => void }) {
        opts?.onTranscriptLine?.(transcript)
        return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
      },
    }

    const replPromise = runRepl(fake, {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("go")
    await new Promise((r) => setTimeout(r, 5))
    editor.cancel()
    await replPromise

    expect(compositor.streams.some((s) => s.includes(transcript))).toBe(true)
  })

  it("emits exactly one '\\n' separator after a response with no trailing newline (no extra blank line)", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()

    const replPromise = runRepl(makeAgent(["Hi! What can I help you with?"], []), {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("hi")
    await new Promise((r) => setTimeout(r, 5))
    editor.cancel()
    await replPromise

    // Find the response chunk and verify the post-turn separator that
    // immediately follows it is exactly "\n" (terminate the partial line),
    // NOT "\n\n" (which would inject an extra blank row before the prompt).
    const idx = compositor.streams.indexOf("Hi! What can I help you with?")
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(compositor.streams[idx + 1]).toBe("\n")
    // And there is no `\n\n` separator anywhere from this turn.
    expect(compositor.streams).not.toContain("\n\n")
  })

  it("emits NO post-turn writeStream when the response already ends with a newline (no flicker, no blank line)", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()

    const replPromise = runRepl(makeAgent(["Done.\n"], []), {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("go")
    await new Promise((r) => setTimeout(r, 5))
    editor.cancel()
    await replPromise

    // The response chunk is the LAST writeStream call of the turn.
    // No trailing "\n" or "\n\n" follows it — the prompt sits directly
    // below the response, and we skip the redundant erase/redraw cycle.
    const idx = compositor.streams.lastIndexOf("Done.\n")
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(compositor.streams.slice(idx + 1)).not.toContain("\n")
    expect(compositor.streams.slice(idx + 1)).not.toContain("\n\n")
  })
})

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
    const { SessionStore } = await import("./session-store.ts")
    const { loadSession } = await import("./session-restore.ts")

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

describe("withRollingCacheBreakpoint", () => {
  const tail = (msgs: Message[]) => {
    const last = msgs[msgs.length - 1]
    if (typeof last.content === "string") return null
    return last.content[last.content.length - 1] as { cache_control?: unknown }
  }

  it("returns the input unchanged when there are no messages", () => {
    expect(withRollingCacheBreakpoint([])).toEqual([])
  })

  it("stamps the last block of the last message with a 1h ephemeral marker", () => {
    const out = withRollingCacheBreakpoint([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ])
    expect(tail(out)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("strips prior message-level cache_control markers", () => {
    const out = withRollingCacheBreakpoint([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "old",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "done" }] },
    ])
    const firstBlock = (out[0].content as Array<{ cache_control?: unknown }>)[0]
    expect(firstBlock.cache_control).toBeUndefined()
    expect(tail(out)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("normalizes a string-content tail into a one-block array before stamping", () => {
    const out = withRollingCacheBreakpoint([{ role: "user", content: "hello" }])
    const last = out[out.length - 1]
    expect(Array.isArray(last.content)).toBe(true)
    expect(tail(out)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("does not mutate the caller's messages array", () => {
    const original: Message[] = [{ role: "user", content: [{ type: "text", text: "a" }] }]
    withRollingCacheBreakpoint(original)
    const block = original[0].content as Array<{ cache_control?: unknown }>
    expect(block[0].cache_control).toBeUndefined()
  })

  // Regression: 400 "`thinking` or `redacted_thinking` blocks in the latest
  // assistant message cannot be modified". When the conversation ends on an
  // assistant turn whose tail is a thinking block (assistant prefill, or a
  // forked/resumed long interleaved-thinking turn re-sent verbatim), the
  // rolling breakpoint must NOT land on the thinking block: adding
  // cache_control to it is a modification the API rejects.
  it("never stamps cache_control on a trailing thinking block of the last message", () => {
    const out = withRollingCacheBreakpoint([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "ponder A", signature: "sigA" },
          { type: "text", text: "partial answer" },
          { type: "thinking", thinking: "ponder B", signature: "sigB" },
        ],
      },
    ])
    const lastBlocks = out[out.length - 1].content as Array<{
      type: string
      cache_control?: unknown
    }>
    // The trailing thinking block stays untouched...
    expect(lastBlocks[2].type).toBe("thinking")
    expect(lastBlocks[2].cache_control).toBeUndefined()
    // ...and the breakpoint moves to the last NON-thinking block.
    expect(lastBlocks[1].type).toBe("text")
    expect(lastBlocks[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    // The earlier thinking block is also left alone.
    expect(lastBlocks[0].cache_control).toBeUndefined()
  })

  it("sends the latest assistant message's thinking blocks byte-identical (text + signature)", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "step 1", signature: "AAA==" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          { type: "thinking", thinking: "step 2", signature: "BBB==" },
        ],
      },
    ]
    const out = withRollingCacheBreakpoint(messages)
    const sent = out[out.length - 1].content as Array<{
      type: string
      thinking?: string
      signature?: string
      cache_control?: unknown
    }>
    const thinking = sent.filter((b) => b.type === "thinking")
    // Both thinking blocks survive verbatim: same text, same signature, and
    // crucially NO cache_control was added or stripped onto them.
    expect(thinking).toEqual([
      { type: "thinking", thinking: "step 1", signature: "AAA==" },
      { type: "thinking", thinking: "step 2", signature: "BBB==" },
    ])
    // The breakpoint landed on the only non-thinking block (the tool_use).
    const toolUse = sent.find((b) => b.type === "tool_use") as { cache_control?: unknown }
    expect(toolUse.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("skips the breakpoint entirely when the last message is all thinking", () => {
    const out = withRollingCacheBreakpoint([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "only thought A", signature: "s1" },
          { type: "thinking", thinking: "only thought B", signature: "s2" },
        ],
      },
    ])
    const lastBlocks = out[out.length - 1].content as Array<{ cache_control?: unknown }>
    // No block gets a breakpoint (a thinking-only tail is left untouched), so
    // the request stays API-valid even though the rolling cache skips a turn.
    expect(lastBlocks.every((b) => b.cache_control === undefined)).toBe(true)
  })

  // Regression: long interleaved-thinking conversations 400 with "`thinking`
  // or `redacted_thinking` blocks in the latest assistant message cannot be
  // modified" once several prior assistant turns' thinking accumulates (~200KB
  // of signatures). The API only needs the LATEST assistant turn's thinking,
  // so older turns' thinking must be stripped before sending. The latest
  // turn's thinking stays byte-identical; tool_use pairing is preserved.
  it("strips thinking from older assistant turns but keeps the latest turn's verbatim", () => {
    const out = withRollingCacheBreakpoint([
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning A", signature: "sigA" },
          { type: "text", text: "doing A" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "a" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ra" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning B", signature: "sigB" },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "b" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "rb" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "latest reasoning", signature: "sigZ" },
          { type: "tool_use", id: "t3", name: "Bash", input: { command: "c" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "rc" }] },
    ])
    // Older assistant turns (indices 1, 3): thinking dropped, tool_use kept.
    for (const i of [1, 3]) {
      const blocks = out[i].content as Array<{ type: string }>
      expect(blocks.some((b) => b.type === "thinking")).toBe(false)
      expect(blocks.some((b) => b.type === "tool_use")).toBe(true)
    }
    // Latest assistant turn (index 5): thinking PRESERVED byte-identical.
    const latest = out[5].content as Array<{ type: string; thinking?: string; signature?: string }>
    expect(latest.find((b) => b.type === "thinking")).toEqual({
      type: "thinking",
      thinking: "latest reasoning",
      signature: "sigZ",
    })
  })

  it("also guards a literal redacted_thinking tail block", () => {
    const out = withRollingCacheBreakpoint([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "here" },
          // The wire type a restored/forked session can carry.
          { type: "redacted_thinking", data: "abc" } as unknown as ContentBlock,
        ],
      },
    ])
    const lastBlocks = out[out.length - 1].content as Array<{
      type: string
      cache_control?: unknown
    }>
    expect(lastBlocks[1].type).toBe("redacted_thinking")
    expect(lastBlocks[1].cache_control).toBeUndefined()
    expect(lastBlocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })
})

// ---------------------------------------------------------------------------
// Modes integration with Agent.run
//
// Verifies the v2.1.119 cache-friendly mode contract end-to-end at the agent
// level: tools stay registered in the request body, the harness refuses
// disallowed tools at dispatch time, and a `<ma::agent::mode-change>` attachment rides
// the next user turn after a toggle. See `src/modes.test.ts` for the unit
// tests of ModeManager itself, and `work/2026-05-03T02:11:34-04:00-docs-plan-mode-design.md`
// for the design rationale.
// ---------------------------------------------------------------------------

describe("Agent.run with ModeManager (dispatch gate + activation attachment)", () => {
  const ASK_MANIFEST = {
    id: "ask",
    label: "ASK",
    disallowedTools: ["Edit", "Write"],
    refusalHint: "Present the proposed change as a unified diff.",
  }

  // Pinned wall-clock for tests that assert on the literal `<ma::agent::mode-change … at="…" />`
  // payload. Injecting `now` into ModeManager keeps the marker byte-stable.
  const FIXED_AT = new Date("2026-05-22T20:43:12.000Z")
  const FIXED_AT_ISO = FIXED_AT.toISOString()
  const fixedNow = () => FIXED_AT

  /**
   * Build a 2-round sendFn that records every request body it receives,
   * emits a `tool_use(Edit)` on round 1 and a final text on round 2.
   * The recorded bodies let assertions inspect `tools` byte-stability.
   */
  function makeRecordingSendFn(records: Array<Record<string, unknown>>) {
    let round = 0
    return async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      // Snapshot only the cache-relevant top-level fields. Deep-clone so
      // later mutations by other turns can't poison the snapshot.
      records.push(
        JSON.parse(
          JSON.stringify({
            messages: opts.messages,
            tools: opts.tools,
            system: opts.system,
            model: opts.model,
          }),
        ),
      )
      round++
      if (round === 1) {
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "call-1",
              name: "Edit",
              input: { path: "x.ts", oldStr: "a", newStr: "b" },
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

  it("refuses a disallowed tool at dispatch (no executeTool call) and synthesizes is_error tool_result", async () => {
    const { ModeManager } = await import("./modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], "ask")

    const records: Array<Record<string, unknown>> = []
    const sendFn = makeRecordingSendFn(records)
    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })

    const transcript: string[] = []
    const gen = agent.run("please edit foo.ts", {
      onTranscriptLine: (line) => transcript.push(line),
    })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // The tool_result that came back to the model carries the refusal
    // message and is_error: true. We can find it in the messages history
    // appended after round 1.
    const history = agent.history()
    // After: user(initial), assistant(tool_use), user(tool_result), assistant(text)
    expect(history.length).toBe(4)
    const toolResultMsg = history[2]
    expect(toolResultMsg.role).toBe("user")
    const tr = (toolResultMsg.content as unknown as Array<Record<string, unknown>>).find(
      (b) => b.type === "tool_result",
    ) as Record<string, unknown>
    expect(tr).toBeDefined()
    expect(tr.is_error).toBe(true)
    expect(String(tr.content)).toContain('Tool "Edit" is denied in ASK mode.')
    expect(String(tr.content)).toContain("unified diff")

    // Transcript must show the denial line so the user sees what was blocked.
    const joinedTranscript = stripAnsi(transcript.join("\n"))
    expect(joinedTranscript).toContain("⊘")
    expect(joinedTranscript).toContain("refused by ask")
  })

  it("keeps the tools array byte-stable across mode toggles (Edit always advertised)", async () => {
    const { ModeManager } = await import("./modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST])
    // Start with no mode active.
    expect(modeManager.activeId()).toBeNull()

    const records: Array<Record<string, unknown>> = []
    const sendFn = makeRecordingSendFn(records)
    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })

    // Round 1: no mode active, run a turn.
    const gen1 = agent.run("hi")
    while (true) {
      const { done } = await gen1.next()
      if (done) break
    }

    // Toggle into ASK between turns.
    modeManager.setMode("ask")

    // Round 2: ASK active.
    const gen2 = agent.run("now edit foo")
    while (true) {
      const { done } = await gen2.next()
      if (done) break
    }

    // Two `agent.run` calls × two API rounds each = 4 recordings. We
    // care about the `tools` field shape across all of them.
    expect(records.length).toBeGreaterThanOrEqual(2)
    const toolsBefore = JSON.stringify(records[0].tools ?? [])
    const toolsAfter = JSON.stringify(records[records.length - 1].tools ?? [])
    expect(toolsBefore).toBe(toolsAfter)

    // And specifically: Edit and Write are still in the advertised list
    // even with ASK active (the dispatch gate enforces, not request shape).
    const lastToolNames = (records[records.length - 1].tools as Array<{ name: string }>).map(
      (t) => t.name,
    )
    expect(lastToolNames).toContain("Edit")
    expect(lastToolNames).toContain("Write")
  })

  it("attaches a <mode-change> block to the next user message after a toggle, then stops on steady state", async () => {
    const { ModeManager } = await import("./modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], null, undefined, fixedNow)

    // 3-turn sendFn: each turn just emits text and ends.
    let round = 0
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      round++
      yield `r${round}`
      return {
        blocks: [{ type: "text" as const, text: `r${round}` }],
        text: `r${round}`,
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })

    // Turn 1: no toggle yet, no attachment.
    const g1 = agent.run("first")
    while (true) {
      const { done } = await g1.next()
      if (done) break
    }
    const turn1User = (records[0].messages as Array<Record<string, unknown>>)[0]
    const turn1Blocks = turn1User.content as Array<Record<string, unknown>>
    expect(turn1Blocks.length).toBe(1)
    expect(turn1Blocks[0].text).toBe("first")

    // Toggle into ASK between turns.
    modeManager.setMode("ask")

    // Turn 2: attachment should be prepended to the user message.
    const g2 = agent.run("second")
    while (true) {
      const { done } = await g2.next()
      if (done) break
    }
    const turn2User = (records[1].messages as Array<Record<string, unknown>>).at(-2) as Record<
      string,
      unknown
    >
    // Find the user message that was JUST appended (= the second-to-last
    // message in the history at request time, since the trailing assistant
    // hasn't been pushed yet — actually, requests go out BEFORE the
    // assistant reply is appended; so the last message in records[1] is
    // the freshly-pushed user message for round 2).
    const turn2Last = (records[1].messages as Array<Record<string, unknown>>).at(-1) as Record<
      string,
      unknown
    >
    expect(turn2Last.role).toBe("user")
    const turn2Blocks = turn2Last.content as Array<Record<string, unknown>>
    expect(turn2Blocks.length).toBe(2)
    // Pull out just the {type,text} fields — the rolling-cache helper
    // stamps `cache_control` on the last block, which we don't care about
    // here. The mode-change attachment must be the FIRST block (so the
    // model sees the activation context before the user's actual input).
    expect({ type: turn2Blocks[0].type, text: turn2Blocks[0].text }).toEqual({
      type: "text",
      text: `<ma::agent::mode-change from="default" to="ask" at="${FIXED_AT_ISO}" />`,
    })
    expect({ type: turn2Blocks[1].type, text: turn2Blocks[1].text }).toEqual({
      type: "text",
      text: "second",
    })
    // Quiet the unused-binding lint by using turn2User for clarity:
    void turn2User

    // Turn 3: no toggle, no attachment — steady-state ASK.
    const g3 = agent.run("third")
    while (true) {
      const { done } = await g3.next()
      if (done) break
    }
    const turn3Last = (records[2].messages as Array<Record<string, unknown>>).at(-1) as Record<
      string,
      unknown
    >
    const turn3Blocks = turn3Last.content as Array<Record<string, unknown>>
    expect(turn3Blocks.length).toBe(1)
    expect({ type: turn3Blocks[0].type, text: turn3Blocks[0].text }).toEqual({
      type: "text",
      text: "third",
    })
  })

  it("does NOT couple mode addendum into the system prompt (sys[3] is mode-independent)", async () => {
    const { ModeManager } = await import("./modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST])

    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ system: opts.system })))
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })

    // No plugin loader → no pluginBlock → system is undefined either way.
    // What we verify: turn 1 (no mode) and turn 2 (ASK active) produce
    // byte-identical `system` payloads. This is the cache invariant.
    const g1 = agent.run("a")
    while (true) {
      const { done } = await g1.next()
      if (done) break
    }
    modeManager.setMode("ask")
    const g2 = agent.run("b")
    while (true) {
      const { done } = await g2.next()
      if (done) break
    }

    expect(JSON.stringify(records[0].system)).toBe(JSON.stringify(records[1].system))
  })

  // --------------------------------------------------------------------------
  // Regression: "if I quickly change modes mid-tool, it 400s and stops working"
  //
  // Repro from net log 1777796322689-... :
  //   - assistant emits tool_use
  //   - user toggles mode while the tool is running
  //   - on the next request, the user message had `<ma::agent::mode-change>` BEFORE
  //     the tool_result block, which the API rejects:
  //       "tool_use ids were found without tool_result blocks immediately
  //        after"
  //   - rollbackPendingTurn() then popped that user message wholesale,
  //     stripping the tool_result entirely, and every subsequent retry
  //     400'd forever with a dangling tool_use.
  //
  // The fix: tool_results go FIRST in the post-tool user message; the
  // mode-change attachment trails them. And rollbackPendingTurn refuses
  // to discard any user message that contains tool_result blocks.
  // --------------------------------------------------------------------------
  it("places tool_result FIRST and <mode-change> AFTER when a toggle happens mid-tool-loop", async () => {
    const { ModeManager } = await import("./modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], null, undefined, fixedNow)

    let round = 0
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      round++
      if (round === 1) {
        // Simulate the user toggling mode while the tool is being
        // dispatched — by the time userContent is assembled for round 2,
        // the ModeManager has a pending attachment AND a tool_result.
        modeManager.setMode("ask")
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "call-1",
              name: "Edit", // disallowed in ASK → refusal tool_result
              input: { path: "x", oldStr: "a", newStr: "b" },
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
    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })

    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // Round 2's request body is what would have hit the API. Inspect the
    // last user message it sent.
    const round2Msgs = records[1].messages as Array<Record<string, unknown>>
    const lastUser = round2Msgs.at(-1) as Record<string, unknown>
    expect(lastUser.role).toBe("user")
    const blocks = lastUser.content as Array<Record<string, unknown>>
    // tool_result MUST be the first block (API contract). mode-change
    // attachment trails. No other ordering is acceptable.
    expect(blocks[0].type).toBe("tool_result")
    expect((blocks[0] as { tool_use_id: string }).tool_use_id).toBe("call-1")
    expect(blocks[1].type).toBe("text")
    expect((blocks[1] as { text: string }).text).toBe(
      `<ma::agent::mode-change from="default" to="ask" at="${FIXED_AT_ISO}" />`,
    )
  })

  it("rollbackPendingTurn() refuses to discard a user message containing tool_result blocks", async () => {
    // Construct an Agent and seed history that mirrors the broken state
    // from the net log: an assistant tool_use followed by a user
    // tool_result. A naive rollback would pop the tool_result, leaving a
    // dangling tool_use that 400s on every subsequent send.
    const auth: AuthResult = { type: "api-key", token: "test" }
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
    }
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn,
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok", is_error: false }],
        },
      ],
    })

    const before = agent.history().length
    const removed = agent.rollbackPendingTurn()
    const after = agent.history().length

    // Nothing was popped: the tool_result-bearing user message stays
    // glued to its tool_use parent.
    expect(removed).toBe(false)
    expect(after).toBe(before)
    expect(agent.history()[2].role).toBe("user")
    const lastBlocks = agent.history()[2].content as unknown as Array<Record<string, unknown>>
    expect(lastBlocks[0].type).toBe("tool_result")
  })

  // --------------------------------------------------------------------------
  // Regression: "text-only assistant reply + pending mode change → orphan
  //  tool_use poisons the session"
  //
  // Repro from session 403c71fe-7cc4-4a2a-b080-b3a8eb9872b6:
  //   - turn opens in ASK, user asks for a script
  //   - assistant ends with text only (stopReason: end_turn), no tool_use
  //   - meanwhile user toggled ASK→default, attachment is pending
  //   - the original ASAP path (post-loop one-shot) pushed a synthetic
  //     `<ma::agent::mode-change>` user turn and made one more API call
  //   - the model, seeing the prior prompt was "save this file", returned
  //     `tool_use` on that follow-up call
  //   - the ASAP path did NOT loop through tool execution: orphan tool_use
  //     was persisted to messages and the session JSONL
  //   - every subsequent user submit 400'd with
  //       "tool_use ids were found without tool_result blocks
  //        immediately after"
  //
  // The fix: handle the synthetic turn INSIDE the main while loop's
  // `toolBlocks.length === 0` branch (consume the pending attachment,
  // push the user turn, `continue` so the next iteration handles any
  // tool_use naturally). No more orphans.
  // --------------------------------------------------------------------------
  it("loops synthetic mode-change turn through tool execution (no orphan tool_use)", async () => {
    const { ModeManager } = await import("./modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], "ask", undefined, fixedNow)

    // 3-round sendFn:
    //  round 1: assistant ends with text only (stopReason: end_turn).
    //           The test toggles the mode AFTER round 1's response is
    //           collected but BEFORE the loop's no-tool-blocks branch
    //           runs : simplest place to drive the pending-state.
    //  round 2: synthetic `<ma::agent::mode-change>` user turn was injected
    //           by the agent. Model now responds with `tool_use` (Bash).
    //  round 3: agent has executed the tool and is asking the model
    //           for a final summary. Model returns text + end_turn.
    let round = 0
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      round++
      if (round === 1) {
        // Mid-turn toggle. Pending attachment from ask → default.
        modeManager.setMode(null)
        return {
          blocks: [{ type: "text" as const, text: "here's a script" }],
          text: "here's a script",
          stopReason: "end_turn",
        } as StreamedResponse
      }
      if (round === 2) {
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "bash-1",
              name: "Bash",
              // No actual command needed; the agent's Bash executor will
              // try to run this. We override via a no-op below.
              input: { command: "echo hi", description: "" },
            },
          ],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "saved"
      return {
        blocks: [{ type: "text" as const, text: "saved" }],
        text: "saved",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })
    const gen = agent.run("write a script")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // Invariant 1: three rounds were sent (the synthetic mode-change turn
    // was looped through the tool-execution machinery, not handled as a
    // one-shot post-loop call).
    expect(records.length).toBe(3)

    // Invariant 2: round 2's request body carries a user message whose
    // ONLY block is the `<ma::agent::mode-change>` attachment (synthetic turn).
    const round2Msgs = records[1].messages as Array<Record<string, unknown>>
    const round2LastUser = round2Msgs.at(-1) as Record<string, unknown>
    expect(round2LastUser.role).toBe("user")
    const round2Blocks = round2LastUser.content as Array<Record<string, unknown>>
    expect(round2Blocks.length).toBe(1)
    expect(round2Blocks[0].type).toBe("text")
    expect((round2Blocks[0] as { text: string }).text).toBe(
      `<ma::agent::mode-change from="ask" to="default" at="${FIXED_AT_ISO}" />`,
    )

    // Invariant 3: round 3's request body carries the matching
    // `tool_result` for `bash-1` as the FIRST block of the trailing user
    // message. No orphan tool_use anywhere.
    const round3Msgs = records[2].messages as Array<Record<string, unknown>>
    const round3LastUser = round3Msgs.at(-1) as Record<string, unknown>
    expect(round3LastUser.role).toBe("user")
    const round3Blocks = round3LastUser.content as Array<Record<string, unknown>>
    expect(round3Blocks[0].type).toBe("tool_result")
    expect((round3Blocks[0] as { tool_use_id: string }).tool_use_id).toBe("bash-1")

    // Invariant 4: history ends with the model's final text response
    // (round 3), not the orphan tool_use from the broken ASAP path.
    const history = agent.history()
    const lastMsg = history.at(-1) as Message
    expect(lastMsg.role).toBe("assistant")
    const lastBlocks = lastMsg.content as unknown as Array<Record<string, unknown>>
    expect(lastBlocks.some((b) => b.type === "tool_use")).toBe(false)
    expect(lastBlocks.some((b) => b.type === "text")).toBe(true)
  })

  it("does NOT synthesize a mode-change turn when no toggle is pending", async () => {
    // Steady-state: assistant ends with text only and the mode hasn't
    // changed since the last advertisement. The loop must exit cleanly
    // after one round, not synthesize a phantom user turn.
    const { ModeManager } = await import("./modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], "ask", undefined, fixedNow)

    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })
    // First run carries the initial `<ma::agent::mode-change default → ask>`
    // attachment (mode starts active). After this turn lastAdvertised
    // === active, so subsequent steady-state runs must not add another.
    const g1 = agent.run("first")
    while (true) {
      const { done } = await g1.next()
      if (done) break
    }
    const g2 = agent.run("second")
    while (true) {
      const { done } = await g2.next()
      if (done) break
    }

    // Exactly two rounds (one per `agent.run` call). No synthetic
    // third round.
    expect(records.length).toBe(2)
    // Round 2's last user message is the user's plain prompt only:
    // no synthetic attachment was injected.
    const round2Msgs = records[1].messages as Array<Record<string, unknown>>
    const round2LastUser = round2Msgs.at(-1) as Record<string, unknown>
    const round2Blocks = round2LastUser.content as Array<Record<string, unknown>>
    expect(round2Blocks.length).toBe(1)
    expect((round2Blocks[0] as { text: string }).text).toBe("second")
  })

  it("does NOT synthesize a mode-change turn for a net-zero toggle (ask → default → ask)", async () => {
    // The user toggles mid-turn but lands back where they started by
    // the time the loop exits. ModeManager.consumePendingAttachment
    // returns null in that case (active === lastAdvertised), so no
    // synthetic turn fires.
    const { ModeManager } = await import("./modes.ts")
    const modeManager = new ModeManager([ASK_MANIFEST], "ask", undefined, fixedNow)

    let round = 0
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      round++
      if (round === 1) {
        // Toggle twice during the round. Net zero.
        modeManager.setMode(null)
        modeManager.setMode("ask")
      }
      yield `r${round}`
      return {
        blocks: [{ type: "text" as const, text: `r${round}` }],
        text: `r${round}`,
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({ auth, model: "test-model", sendFn, modeManager })
    const gen = agent.run("hello")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // One round only. Net-zero toggle does not synthesize a follow-up.
    expect(records.length).toBe(1)
  })

  it("rollbackPendingTurn() still pops a plain-text trailing user message", async () => {
    // Negative control: a user message with NO tool_result blocks (the
    // common case — a plain prompt that the API rejected for some other
    // reason) MUST still be poppable so the user can resubmit cleanly.
    const auth: AuthResult = { type: "api-key", token: "test" }
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
    }
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn,
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "second (failed)" }] },
      ],
    })

    expect(agent.rollbackPendingTurn()).toBe(true)
    expect(agent.history().length).toBe(2)
    expect(agent.history()[1].role).toBe("assistant")
  })

  // --------------------------------------------------------------------------
  // Regression: orphan tool_use poisons every retry
  //
  // Symptom: user aborts a turn (Esc / Ctrl+C / Alt+M) after the assistant
  // has streamed a `tool_use` block but before the for-loop produces a
  // matching `tool_result`. The orphan tool_use stays in `this.messages`.
  // Every subsequent submit ships that orphan to the API, which 400s with
  // "tool_use ids were found without tool_result blocks immediately after".
  //
  // The fix lives in `Agent.repairOrphanedToolUse()` + the prepend hook
  // at the top of `Agent.run()`'s initial-user-content build. Synthetic
  // `is_error: true` tool_results pair the orphans so the next request
  // is well-formed.
  // --------------------------------------------------------------------------
  describe("Agent.repairOrphanedToolUse (abort-orphan repair)", () => {
    it("returns synthetic is_error:true blocks for every orphan tool_use", async () => {
      const auth: AuthResult = { type: "api-key", token: "test" }
      const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
      }
      const agent = new Agent({
        auth,
        model: "test-model",
        sendFn,
        initialMessages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call-a", name: "Bash", input: { command: "ls" } },
              { type: "tool_use", id: "call-b", name: "Read", input: { file_path: "/x" } },
            ],
          },
        ],
      })

      const repair = agent.repairOrphanedToolUse()
      expect(repair.length).toBe(2)
      expect(repair[0]).toEqual({
        type: "tool_result",
        tool_use_id: "call-a",
        content: "Tool execution aborted by user before completion.",
        is_error: true,
      })
      expect(repair[1].tool_use_id).toBe("call-b")
      expect(repair[1].is_error).toBe(true)
    })

    it("returns [] when the trailing assistant message has no tool_use blocks", async () => {
      const auth: AuthResult = { type: "api-key", token: "test" }
      const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
      }
      const agent = new Agent({
        auth,
        model: "test-model",
        sendFn,
        initialMessages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ],
      })
      expect(agent.repairOrphanedToolUse()).toEqual([])
    })

    it("returns [] when the trailing message is a user (clean state)", async () => {
      const auth: AuthResult = { type: "api-key", token: "test" }
      const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
      }
      const agent = new Agent({
        auth,
        model: "test-model",
        sendFn,
        initialMessages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "c1", content: "ok", is_error: false }],
          },
        ],
      })
      expect(agent.repairOrphanedToolUse()).toEqual([])
    })

    it("returns [] when history is empty", async () => {
      const auth: AuthResult = { type: "api-key", token: "test" }
      const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        return { blocks: [], text: "", stopReason: "end_turn" } as StreamedResponse
      }
      const agent = new Agent({ auth, model: "test-model", sendFn })
      expect(agent.repairOrphanedToolUse()).toEqual([])
    })
  })

  it("Agent.run() prepends synthetic tool_results when history starts with an orphaned tool_use", async () => {
    // End-to-end: simulate a session that resumes from a JSONL with an
    // orphaned assistant tool_use (the "Esc-during-Bash + retry" repro
    // from session 403c71fe). Submit a follow-up. The next API request
    // body must have the synthetic tool_result as the FIRST block of
    // the new user message, with the user's text following.
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      yield "got it"
      return {
        blocks: [{ type: "text" as const, text: "got it" }],
        text: "got it",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn,
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "save it" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "sig" },
            { type: "tool_use", id: "bash-orphan", name: "Bash", input: { command: "ls ~/bin" } },
          ],
        },
      ],
    })

    const gen = agent.run("save it in ~/Projects/...")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // Inspect the (only) request body. It must be well-formed:
    //   - 3 messages: original user, assistant(orphan), new user
    //   - The new user message's content must start with a tool_result
    //     for `bash-orphan` (is_error: true) and end with the user text.
    expect(records.length).toBe(1)
    const msgs = records[0].messages as Array<Record<string, unknown>>
    expect(msgs.length).toBe(3)
    const newUser = msgs[2]
    expect(newUser.role).toBe("user")
    const blocks = newUser.content as Array<Record<string, unknown>>
    // First block is the orphan-repair tool_result, second is the text.
    expect(blocks[0].type).toBe("tool_result")
    expect((blocks[0] as { tool_use_id: string }).tool_use_id).toBe("bash-orphan")
    expect((blocks[0] as { is_error: boolean }).is_error).toBe(true)
    expect((blocks[0] as { content: string }).content).toContain("aborted by user")
    // The text block lands after the synthetic result.
    const textBlock = blocks.find((b) => b.type === "text")
    expect(textBlock).toBeDefined()
    expect((textBlock as { text: string }).text).toBe("save it in ~/Projects/...")
  })

  it("Agent.run() does NOT prepend repair blocks when history is clean", async () => {
    // Negative control: a paired session (assistant tool_use + user
    // tool_result) must not receive synthetic blocks. Same shape as the
    // most common state, hot path, MUST stay byte-stable.
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const auth: AuthResult = { type: "api-key", token: "test" }
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn,
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c1", content: "ok", is_error: false }],
        },
        { role: "assistant", content: [{ type: "text", text: "ack" }] },
      ],
    })

    const gen = agent.run("next thing")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const msgs = records[0].messages as Array<Record<string, unknown>>
    const newUser = msgs[msgs.length - 1]
    const blocks = newUser.content as Array<Record<string, unknown>>
    // No tool_result blocks in a clean-state continuation.
    expect(blocks.some((b) => b.type === "tool_result")).toBe(false)
    // Just the user's text.
    expect(blocks[0].type).toBe("text")
    expect((blocks[0] as { text: string }).text).toBe("next thing")
  })
})

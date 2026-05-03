import { describe, expect, it } from "bun:test"
import { Agent, type ReplAgentLike, runRepl, withRollingCacheBreakpoint } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { Message, StreamedResponse } from "./client.ts"
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
  it("ignores blank turns, advertises Ctrl+C quit, and omits turn separators", async () => {
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
    // REPL header advertises the quit chord. Pinned to current spelling.
    expect(text).toContain("ctrl+c quit")
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

  it("forwards opts.signal to sendFn so the transport can be torn down", async () => {
    let captured: { signal?: AbortSignal } | null = null
    const sendFn = async function* (opts: Record<string, unknown>) {
      captured = opts as { signal?: AbortSignal }
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
    expect(captured).not.toBeNull()
    expect((captured as { signal?: AbortSignal }).signal).toBe(ac.signal)
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
})

// ---------------------------------------------------------------------------
// Modes integration with Agent.run
//
// Verifies the v2.1.119 cache-friendly mode contract end-to-end at the agent
// level: tools stay registered in the request body, the harness refuses
// disallowed tools at dispatch time, and a `<mode-change>` attachment rides
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

  /**
   * Build a 2-round sendFn that records every request body it receives,
   * emits a `tool_use(Edit)` on round 1 and a final text on round 2.
   * The recorded bodies let assertions inspect `tools` byte-stability.
   */
  function makeRecordingSendFn(records: Array<Record<string, unknown>>) {
    let round = 0
    return async function* (opts: Record<string, unknown>): AsyncGenerator<
      string,
      StreamedResponse,
      undefined
    > {
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
    const tr = (toolResultMsg.content as Array<Record<string, unknown>>).find(
      (b) => b.type === "tool_result",
    ) as Record<string, unknown>
    expect(tr).toBeDefined()
    expect(tr.is_error).toBe(true)
    expect(String(tr.content)).toContain('Tool "Edit" is not permitted in ASK mode.')
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
    const modeManager = new ModeManager([ASK_MANIFEST])

    // 3-turn sendFn: each turn just emits text and ends.
    let round = 0
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (opts: Record<string, unknown>): AsyncGenerator<
      string,
      StreamedResponse,
      undefined
    > {
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
      text: '<mode-change from="default" to="ask" />',
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

    let round = 0
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (opts: Record<string, unknown>): AsyncGenerator<
      string,
      StreamedResponse,
      undefined
    > {
      records.push(JSON.parse(JSON.stringify({ system: opts.system })))
      round++
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
  //   - on the next request, the user message had `<mode-change>` BEFORE
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
    const modeManager = new ModeManager([ASK_MANIFEST])

    let round = 0
    const records: Array<Record<string, unknown>> = []
    const sendFn = async function* (opts: Record<string, unknown>): AsyncGenerator<
      string,
      StreamedResponse,
      undefined
    > {
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
      '<mode-change from="default" to="ask" />',
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
          content: [
            { type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-1", content: "ok", is_error: false },
          ],
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
    const lastBlocks = agent.history()[2].content as Array<Record<string, unknown>>
    expect(lastBlocks[0].type).toBe("tool_result")
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
})

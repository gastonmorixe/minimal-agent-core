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

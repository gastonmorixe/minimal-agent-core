import { EventEmitter } from "node:events"

import { describe, expect, it } from "bun:test"

import { type ReplAgentLike, runRepl } from "./agent.ts"
import type { StreamedResponse } from "./client.ts"
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
    // `src/ui/chrome/ready-banner.ts`; its content has its own unit test.
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

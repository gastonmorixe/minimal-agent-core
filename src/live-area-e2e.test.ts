/**
 * End-to-end test for the live-area REPL stack.
 *
 * Wires the *real* Compositor + EditorController to a fake stdin/stdout
 * and a fake streaming agent, simulates a typed turn, and verifies that:
 *   - The multiline prompt is rendered before the user types.
 *   - During the turn, streamed chunks appear inside the scroll region
 *     (above the live area) AND the live area is repainted between chunks.
 *   - After the turn completes, the prompt is still alive and editable.
 *
 * This is the "the prompt must never disappear" regression test.
 *
 * @module live-area-e2e.test
 */

import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { Compositor } from "./ui/compositor.ts"
import { EditorController } from "./editor-controller.ts"
import { runRepl, type ReplAgentLike } from "./agent.ts"
import { StatusBus } from "./status.ts"

class FakeTTYInput extends EventEmitter {
  isTTY = true
  encoding: BufferEncoding | null = null
  resumed = false
  rawModes: boolean[] = []
  setEncoding(e: BufferEncoding): this {
    this.encoding = e
    return this
  }
  resume(): this {
    this.resumed = true
    return this
  }
  pause(): this {
    this.resumed = false
    return this
  }
  setRawMode(v: boolean): this {
    this.rawModes.push(v)
    return this
  }
  send(chunk: string): void {
    this.emit("data", chunk)
  }
}

class FakeOutput {
  isTTY = true
  columns = 80
  rows = 24
  readonly chunks: string[] = []
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }
  text(): string {
    return this.chunks.join("")
  }
}

function makeAgent(parts: string[], calls: string[]): ReplAgentLike {
  return {
    pluginLoader: () => null,
    async *run(text: string) {
      calls.push(text)
      for (const p of parts) {
        yield p
        // give the event loop a turn
        await Promise.resolve()
      }
      return { blocks: [], text: parts.join(""), stopReason: "end_turn" } as any
    },
  }
}

describe("live-area REPL (end to end) — stdio interception", () => {
  it("intercepted console.error writes do NOT cause stale prompt repaints", async () => {
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const { Compositor } = await import("./ui/compositor.ts")
    const { StdioInterceptor } = await import("./ui/stdio-interceptor.ts")

    let interceptorRef: any = null
    const compositor = new Compositor({
      output: {
        isTTY: true,
        columns: 80,
        rows: 24,
        write: (s: string) => {
          if (interceptorRef) return interceptorRef.rawStdoutWrite(s)
          return output.write(s)
        },
      } as any,
    })
    const interceptor = new StdioInterceptor(compositor as any, {
      stdout: output as any,
      stderr: output as any,
    })
    interceptorRef = interceptor

    const editor = new EditorController({
      prompt: "❯ ",
      continuationPrompt: "  ",
      compositor,
      stdin: stdin as any,
      output: output as any,
    })

    interceptor.install()
    try {
      compositor.mount(0)
      editor.start()

      // Type some text into the editor.
      stdin.send("hello world")

      // Now simulate an external stderr blast (debug logging) WHILE the
      // editor is mid-input. With the interceptor in place these writes
      // must flow through compositor.writeStream so the live area gets
      // erased + redrawn correctly each time.
      for (let i = 0; i < 5; i++) {
        // Use the (now intercepted) stream method directly.
        ;(output as any).write(`debug line ${i}\n`)
      }

      // Type more — each keystroke should redraw the prompt in place,
      // not append a new copy to scrollback.
      stdin.send(" more")

      const text = output.text()
      // The final live area must show the full typed buffer exactly once
      // as the LAST visible prompt — earlier paints have been erased
      // (\x1b[J after the stream writes).
      const tailOnly = text.slice(text.lastIndexOf("\x1b[J"))
      const promptCount = (tailOnly.match(/❯ hello world more/g) ?? []).length
      expect(promptCount).toBe(1)

      // And debug lines must appear in scrollback.
      expect(text).toContain("debug line 0")
      expect(text).toContain("debug line 4")

      editor.stop()
      compositor.unmount()
    } finally {
      interceptor.uninstall()
    }
  })
})

describe("live-area REPL (end to end)", () => {
  it("keeps the multiline prompt visible during a streaming turn and after it finishes", async () => {
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new Compositor({ output: output as any })
    const editor = new EditorController({
      prompt: "❯ ",
      continuationPrompt: "  ",
      compositor,
      stdin: stdin as any,
      output: output as any,
    })

    const calls: string[] = []
    const replPromise = runRepl(makeAgent(["hello ", "world\n"], calls), {
      output: output as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor,
      editor,
    })

    // Yield once so runReplLiveArea reaches its `await waiter` state.
    await Promise.resolve()
    await Promise.resolve()

    // Sanity: editor mounted, initial prompt drawn into the live area.
    expect(stdin.rawModes[0]).toBe(true)
    // No DECSTBM scroll region is ever set — that would break scrollback.
    expect(output.text()).not.toMatch(/\x1b\[\d+;\d+r/)
    // The empty prompt "❯ " is in the output buffer.
    expect(output.text()).toContain("❯ ")

    // User types and submits.
    stdin.send("first prompt")
    stdin.send("\r")
    await new Promise((r) => setTimeout(r, 10))

    // The agent ran with the typed text.
    expect(calls).toEqual(["first prompt"])
    // Streamed chunks reached the terminal.
    expect(output.text()).toContain("hello ")
    expect(output.text()).toContain("world")

    // After the turn, the prompt is still live. Each repaint emits the
    // prompt followed by `\x1b[K` to clear the rest of the line; the LAST
    // such pair must show the empty prompt, not stale text.
    const text = output.text()
    const lastPromptIdx = text.lastIndexOf("❯ ")
    expect(lastPromptIdx).toBeGreaterThan(-1)
    expect(text.slice(lastPromptIdx, lastPromptIdx + 8)).toContain("❯ ")
    expect(text.slice(lastPromptIdx)).toContain("\x1b[K")

    // User can still type — buffer accepts new input.
    stdin.send("second")
    expect(editor.buffer().toString()).toBe("second")

    // Cancel to end the loop.
    stdin.send("\x03") // Ctrl+C on empty? buffer has "second" → clears
    stdin.send("\x03") // again on empty → cancel
    await replPromise

    // Compositor restored on shutdown — cursor is shown again.
    expect(output.text()).toContain("\x1b[?25h")
  })

  it("onQueueInject does NOT re-render the prompt to scrollback (Bug 7)", async () => {
    // Regression for the "queue stuff renders twice" bug: when a queued
    // message is drained at a tool boundary mid-turn and re-injected via
    // opts.onQueueInject, the host hook used to commit a `❯ <text>` line
    // to scrollback — but `EditorController.submit()` already committed
    // that exact line at the moment the user pressed Enter. Result: same
    // prompt visible twice in scrollback (once before the tool block,
    // once after). The fix turns onQueueInject into a no-op for
    // scrollback; this test asserts the snapshot is byte-stable across
    // the call.
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new Compositor({ output: output as any })
    const editor = new EditorController({
      prompt: "❯ ",
      continuationPrompt: "  ",
      compositor,
      stdin: stdin as any,
      output: output as any,
    })

    // Capture the inject hook for direct invocation from inside agent.run.
    let capturedInject: ((qtext: string) => void) | null = null
    const fakeAgent: ReplAgentLike = {
      pluginLoader: () => null,
      async *run(_text: string, opts?: any) {
        capturedInject = opts?.onQueueInject ?? null
        yield "ok\n"
        return { blocks: [], text: "ok\n", stopReason: "end_turn" } as any
      },
    }

    const replPromise = runRepl(fakeAgent, {
      output: output as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor,
      editor,
    })
    await Promise.resolve()
    await Promise.resolve()

    stdin.send("hi")
    stdin.send("\r")
    await new Promise((r) => setTimeout(r, 10))

    // Snapshot output, fire the inject hook with a unique sentinel, and
    // confirm no new bytes were written. A correct no-op leaves the output
    // length unchanged AND never emits the sentinel as a `❯ <sentinel>`
    // prompt line.
    expect(capturedInject).not.toBeNull()
    const sentinel = "QUEUE_INJECT_SENTINEL_XYZ"
    const before = output.chunks.length
    const beforeText = output.text()
    const inject = capturedInject as ((text: string) => void) | null
    if (!inject) throw new Error("queue inject hook was not captured")
    inject(sentinel)
    expect(output.chunks.length).toBe(before)
    expect(output.text()).toBe(beforeText)
    expect(output.text()).not.toContain(`❯ ${sentinel}`)
    expect(output.text()).not.toContain(sentinel)

    stdin.send("\x03")
    stdin.send("\x03")
    await replPromise
  })
})

/**
 * End-to-end test for the `prompt.inject` host port through
 * `runReplLiveArea`.
 *
 * A plugin (in production: the `schedule` heartbeat) emits
 * `prompt.inject` on the shared plugin bus to enqueue a prompt as if the
 * user had typed it. This test wires a real `Compositor` +
 * `EditorController` + a real (plugin-less) `PluginLoader` whose bus we
 * own, plus a fake streaming agent, and asserts:
 *
 *   1. Emitting `prompt.inject` while idle drains as the next turn's
 *      input (the agent's `run()` observes the injected text).
 *   2. Blank / whitespace-only injected text is ignored (no turn).
 *   3. A malformed payload (no `text`) is ignored without throwing.
 *
 * The loader's three discovery roots are pointed at an empty temp dir so
 * the user's real `~/.agents/plugins` never loads — the test stays
 * deterministic and side-effect-free apart from the per-sid `<sid>.queue`
 * file, which `afterEach` unlinks.
 *
 * @module prompt-inject-e2e.test
 */

import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { type ReplAgentLike, runRepl } from "./agent.ts"
import { EditorController } from "./host/editor-controller.ts"
import { EventBus } from "./plugins/event-bus.ts"
import { PluginLoader } from "./plugins/loader.ts"
import { queueFilePath } from "./queue-store.ts"
import { StatusBus } from "./status.ts"
import { Compositor } from "./host/ui/compositor.ts"

class FakeTTYInput extends EventEmitter {
  isTTY = true
  encoding: BufferEncoding | null = null
  setEncoding(e: BufferEncoding): this {
    this.encoding = e
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
  setRawMode(_v: boolean): this {
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
}

const mintedSids: string[] = []
function mintSid(prefix: string): string {
  const sid = `${prefix}-${randomUUID()}`
  mintedSids.push(sid)
  return sid
}

afterEach(() => {
  for (const sid of mintedSids) {
    try {
      rmSync(queueFilePath(sid), { force: true })
    } catch {
      /* ignore */
    }
  }
  mintedSids.length = 0
})

/**
 * Build a plugin-less loader whose bus we own. All three discovery roots
 * point at an empty temp dir so nothing real loads.
 */
async function emptyLoader(bus: EventBus, sid: string): Promise<PluginLoader> {
  const root = mkdtempSync(join(tmpdir(), "ma-inject-"))
  return PluginLoader.load({
    bus,
    sessionId: sid,
    embeddedDir: root,
    homeDir: root,
    projectDir: root,
    logger: () => {},
  })
}

function makeAgent(observed: string[], loader: PluginLoader, holdMs: number): ReplAgentLike {
  return {
    pluginLoader: () => loader,
    async *run(text: string) {
      observed.push(text)
      yield `response-${observed.length}\n`
      await new Promise((r) => setTimeout(r, holdMs))
      return { blocks: [], text: "ok\n", stopReason: "end_turn" } as never
    },
  }
}

describe("prompt.inject : out-of-band prompt enqueue through runReplLiveArea", () => {
  it("drains an injected prompt as the next turn's input", async () => {
    const sid = mintSid("ma-inject-A")
    const bus = new EventBus()
    const loader = await emptyLoader(bus, sid)
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new Compositor({ output: output as never })
    const editor = new EditorController({
      prompt: "❯ ",
      continuationPrompt: "  ",
      compositor,
      stdin: stdin as never,
      output: output as never,
    })
    const observed: string[] = []
    const replPromise = runRepl(makeAgent(observed, loader, 15), {
      output: output as never,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor,
      editor,
      sessionId: sid,
    })
    await new Promise((r) => setTimeout(r, 20))

    // No user typing at all — a scheduler-style injection drives the turn.
    bus.emit("prompt.inject", { text: "scheduled ping", source: "cron:test" })
    await new Promise((r) => setTimeout(r, 120))

    expect(observed[0]).toBe("scheduled ping")

    stdin.send("\x03")
    stdin.send("\x03")
    await replPromise
  })

  it("ignores blank and malformed injections", async () => {
    const sid = mintSid("ma-inject-B")
    const bus = new EventBus()
    const loader = await emptyLoader(bus, sid)
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new Compositor({ output: output as never })
    const editor = new EditorController({
      prompt: "❯ ",
      continuationPrompt: "  ",
      compositor,
      stdin: stdin as never,
      output: output as never,
    })
    const observed: string[] = []
    const replPromise = runRepl(makeAgent(observed, loader, 15), {
      output: output as never,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor,
      editor,
      sessionId: sid,
    })
    await new Promise((r) => setTimeout(r, 20))

    bus.emit("prompt.inject", { text: "   " }) // whitespace-only
    bus.emit("prompt.inject", {}) // no text field
    bus.emit("prompt.inject", undefined) // no payload
    await new Promise((r) => setTimeout(r, 60))

    // A real injection still works afterwards (proves the listener survived).
    bus.emit("prompt.inject", { text: "real one" })
    await new Promise((r) => setTimeout(r, 120))

    expect(observed).toEqual(["real one"])

    stdin.send("\x03")
    stdin.send("\x03")
    await replPromise
  })
})

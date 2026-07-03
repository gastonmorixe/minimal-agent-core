/**
 * End-to-end test that a registered slash command, submitted through the
 * REPL, is dispatched out-of-band instead of becoming a model turn — and
 * that non-commands / unknown commands still flow to the agent as prompts.
 *
 * Drives submits via the `prompt.inject` bus channel (which routes through
 * the same `onSubmit` command-interception path as a typed line), so we
 * avoid simulating keystrokes. A real `PluginLoader` loads a one-command
 * fixture plugin from a temp dir; its bus is shared with the REPL.
 *
 *   - `/x expand` → CommandResult `expand` → agent runs the expanded prompt
 *   - `/x notice` → CommandResult `notice` → NO agent turn
 *   - `hello`     → ordinary prompt → agent runs `hello`
 *   - `/unknown`  → unregistered → ordinary prompt → agent runs `/unknown`
 *
 * @module command-repl-e2e.test
 */

import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { type ReplAgentLike, runRepl } from "./agent.ts"
import { StatusBus } from "./bus/status.ts"
import { EditorController } from "./host/editor-controller.ts"
import { Compositor } from "./host/ui/compositor.ts"
import { EventBus } from "./plugins/event-bus.ts"
import { PluginLoader } from "./plugins/loader.ts"
import { queueFilePath } from "./session/queue-store.ts"

class FakeTTYInput extends EventEmitter {
  isTTY = true
  setEncoding(): this {
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
  setRawMode(): this {
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

const roots: string[] = []
let sid = ""
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots.length = 0
  if (sid) rmSync(queueFilePath(sid), { force: true })
})

const HANDLER = `
export default (ctx) => {
  if (ctx.argv === "expand") return { kind: "expand", prompt: "RAN:" + ctx.argv }
  if (ctx.argv === "notice") return { kind: "notice", lines: ["did a thing"] }
  return { kind: "none" }
}
`

async function loaderWithCommand(bus: EventBus): Promise<PluginLoader> {
  const root = mkdtempSync(join(tmpdir(), "ma-cmd-repl-"))
  roots.push(root)
  const dir = join(root, "plugins", "xcmd")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "xcmd",
      name: "xcmd",
      version: "0.1.0",
      description: "test",
      commands: [{ name: "x", summary: "x cmd", handler: { type: "module", path: "./cmd.ts" } }],
    }),
  )
  writeFileSync(join(dir, "cmd.ts"), HANDLER)
  return PluginLoader.load({
    bus,
    embeddedDir: root,
    homeDir: root,
    projectDir: root,
    logger: () => {},
  })
}

function makeAgent(observed: string[], loader: PluginLoader): ReplAgentLike {
  return {
    pluginLoader: () => loader,
    async *run(text: string) {
      observed.push(text)
      yield "ok\n"
      await new Promise((r) => setTimeout(r, 10))
      return { blocks: [], text: "ok\n", stopReason: "end_turn" } as never
    },
  }
}

describe("slash command dispatch through the REPL", () => {
  it("routes commands vs prompts correctly", async () => {
    sid = `ma-cmd-repl-${Date.now()}`
    const bus = new EventBus()
    const loader = await loaderWithCommand(bus)
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
    const replPromise = runRepl(makeAgent(observed, loader), {
      output: output as never,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor,
      editor,
      sessionId: sid,
    })
    await new Promise((r) => setTimeout(r, 25))

    // notice: no model turn
    bus.emit("prompt.inject", { text: "/x notice" })
    await new Promise((r) => setTimeout(r, 60))
    expect(observed).toEqual([])

    // expand: model turn with the expanded prompt
    bus.emit("prompt.inject", { text: "/x expand" })
    await new Promise((r) => setTimeout(r, 80))
    expect(observed).toEqual(["RAN:expand"])

    // ordinary prompt
    bus.emit("prompt.inject", { text: "hello there" })
    await new Promise((r) => setTimeout(r, 80))
    expect(observed).toEqual(["RAN:expand", "hello there"])

    // unknown command → falls through as an ordinary prompt
    bus.emit("prompt.inject", { text: "/unknown thing" })
    await new Promise((r) => setTimeout(r, 80))
    expect(observed).toEqual(["RAN:expand", "hello there", "/unknown thing"])

    stdin.send("\x03")
    stdin.send("\x03")
    await replPromise
  })
})

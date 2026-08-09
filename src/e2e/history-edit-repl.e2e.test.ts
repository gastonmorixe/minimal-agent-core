import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { type ReplAgentLike, runRepl } from "../agent/agent.ts"
import { StatusBus } from "../bus/status.ts"
import { EditorController } from "../host/editor-controller.ts"
import { Compositor } from "../host/ui/compositor.ts"
import { EventBus } from "../plugins/event-bus.ts"
import { PluginLoader } from "../plugins/loader.ts"
import { loadQueue, QueueStore } from "../session/queue-store.ts"
import { SessionStore } from "../session/session-store.ts"

class Input extends EventEmitter {
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
  send(text: string): void {
    this.emit("data", text)
  }
}
class Output {
  isTTY = true
  columns = 80
  rows = 24
  chunks: string[] = []
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }
  text(): string {
    return this.chunks.join("")
  }
}

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("history edit live-area command bridge", () => {
  test("preloads strict history, clears queue, then expands only after reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "ma-history-edit-e2e-"))
    roots.push(root)
    const sessions = join(root, "sessions")
    const sid = "history-edit-e2e"
    const store = SessionStore.open({
      sid,
      model: "test",
      cwd: root,
      systemHash: "s",
      toolsHash: "t",
      agentVersion: "t",
      dir: sessions,
    })
    store.appendUser("keep")
    store.appendAssistant([{ type: "text", text: "kept reply" }], "end_turn")
    const target = store.appendUser("replace me")
    store.appendAssistant([{ type: "text", text: "dropped reply" }], "end_turn")
    store.appendUser("dropped future")
    new QueueStore(sid, { dir: sessions }).save([{ text: "queued future", commitLines: [] }])

    const pluginDir = join(root, "plugins", "history-edit")
    mkdirSync(pluginDir, { recursive: true })
    await Bun.write(
      join(pluginDir, "manifest.json"),
      JSON.stringify({
        id: "history-edit",
        name: "history-edit",
        version: "0.1.0",
        description: "test",
        capabilities: ["sessions:write"],
        commands: [
          { name: "history-edit", summary: "test", handler: { type: "module", path: "./cmd.ts" } },
        ],
      }),
    )
    await Bun.write(
      join(pluginDir, "cmd.ts"),
      `export default async (ctx) => {
      const begun = await ctx.host.sessionsWrite.beginHistoryEdit({ targetUserId: ${JSON.stringify(target)} })
      if (!begun.ok) return { kind: "error", message: begun.message }
      const committed = await ctx.host.sessionsWrite.commitHistoryEdit({ targetUserId: ${JSON.stringify(target)}, backupSid: begun.backupSid })
      if (!committed.ok) return { kind: "error", message: committed.message }
      return { kind: "expand", prompt: "replacement" }
    }`,
    )

    const bus = new EventBus()
    const loader = await PluginLoader.load({
      bus,
      sessionId: sid,
      embeddedDir: root,
      homeDir: root,
      projectDir: root,
      hostOptions: { sessionsDir: sessions },
      logger: () => {},
    })
    const replaced: unknown[] = []
    const runs: Array<{ text: string; history: unknown[] }> = []
    const agent: ReplAgentLike = {
      pluginLoader: () => loader,
      agentCore: () =>
        ({
          replaceMessages: (messages: unknown[]) => replaced.push(messages),
          history: () => replaced.at(-1) ?? [],
        }) as any,
      async *run(text: string) {
        runs.push({ text, history: (replaced.at(-1) as unknown[] | undefined) ?? [] })
        yield "ok"
        return {} as never
      },
    }
    const stdin = new Input()
    const output = new Output()
    const compositor = new Compositor({ output: output as any })
    const editor = new EditorController({
      prompt: "❯ ",
      continuationPrompt: "  ",
      compositor,
      stdin: stdin as any,
      output: output as any,
    })
    const repl = runRepl(agent, {
      useLiveArea: true,
      compositor,
      editor,
      output: output as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      sessionId: sid,
      sessionsDir: sessions,
    })
    await wait(30)
    bus.emit("command.run", { line: "/history-edit commit" })
    await wait(100)

    expect(replaced).toHaveLength(1)
    expect(JSON.stringify(replaced[0])).toContain("keep")
    expect(JSON.stringify(replaced[0])).not.toContain("replace me")
    expect(JSON.stringify(replaced[0])).not.toContain("dropped future")
    expect(runs.map((run) => run.text)).toEqual(["replacement"])
    expect(runs[0]?.history).toEqual(replaced[0] as unknown[])
    await wait(30)
    expect(loadQueue(sid, sessions)).toEqual([])
    expect(output.text()).toContain(`--resume ${sid}-backup-01`)
    stdin.send("\x03")
    stdin.send("\x03")
    await repl
  })
})

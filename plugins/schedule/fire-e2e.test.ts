/**
 * Capstone end-to-end: the real schedule plugin, loaded by the real
 * PluginLoader into a real REPL, fires a due task through the whole chain
 * — heartbeat slot → store → due → `ctx.emit("prompt.inject")` →
 * `prompt.inject` bus channel → REPL `onSubmit` → agent `run()`.
 *
 * A one-shot is pre-seeded to fire ~1.5s out (so the resume-prune at
 * tick 0 keeps it). The live-area scheduler ticks the heartbeat every
 * second; by ~2s `now >= nextAtMs` and the prompt is injected.
 *
 * @module schedule/fire-e2e.test
 */

import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { type ReplAgentLike, runRepl } from "../../src/agent.ts"
import { EditorController } from "../../src/editor-controller.ts"
import { EventBus } from "../../src/plugins/event-bus.ts"
import { PluginLoader } from "../../src/plugins/loader.ts"
import { Compositor } from "../../src/ui/compositor.ts"
import { StatusBus } from "../../src/status.ts"
import { CronStore } from "./lib/store.ts"

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
  send(s: string): void {
    this.emit("data", s)
  }
}
class FakeOutput {
  isTTY = true
  columns = 80
  rows = 24
  write(): boolean {
    return true
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c()
    } catch {
      /* ignore */
    }
  }
})

describe("schedule end-to-end firing", () => {
  it("injects a due task's prompt into the agent via the heartbeat", async () => {
    const cronDir = mkdtempSync(join(tmpdir(), "ma-fire-store-"))
    const root = mkdtempSync(join(tmpdir(), "ma-fire-root-"))
    mkdirSync(join(root, "plugins"), { recursive: true })
    symlinkSync(import.meta.dir, join(root, "plugins", "schedule"))
    const sid = `ma-fire-${Date.now()}`
    const prevEnv = process.env.MINIMAL_AGENT_CRON_DIR
    process.env.MINIMAL_AGENT_CRON_DIR = cronDir
    cleanups.push(() => {
      if (prevEnv === undefined) delete process.env.MINIMAL_AGENT_CRON_DIR
      else process.env.MINIMAL_AGENT_CRON_DIR = prevEnv
      rmSync(cronDir, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    })

    // Pre-seed a one-shot due in ~1.5s (future, so tick-0 prune keeps it).
    const store = new CronStore(sid, { dir: cronDir })
    const now = Date.now()
    store.create(
      { cron: "* * * * *", prompt: "SCHEDULED FIRE", recurs: false, nextAtMs: now + 1500 },
      now,
    )

    const bus = new EventBus()
    const loader = await PluginLoader.load({
      bus,
      sessionId: sid,
      embeddedDir: root,
      homeDir: root,
      projectDir: root,
      logger: () => {},
    })

    const observed: string[] = []
    const agent: ReplAgentLike = {
      pluginLoader: () => loader,
      async *run(text: string) {
        observed.push(text)
        yield "ok\n"
        return { blocks: [], text: "ok\n", stopReason: "end_turn" } as never
      },
    }

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
    const replPromise = runRepl(agent, {
      output: output as never,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor,
      editor,
      sessionId: sid,
    })

    // Wait long enough for ~2 heartbeat ticks to cross nextAtMs.
    await new Promise((r) => setTimeout(r, 3500))

    expect(observed).toContain("SCHEDULED FIRE")
    // The one-shot deleted itself after firing.
    expect(store.count()).toBe(0)

    stdin.send("\x03")
    stdin.send("\x03")
    await replPromise
  }, 15_000)
})

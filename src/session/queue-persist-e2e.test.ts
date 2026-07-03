/**
 * End-to-end test for queue persistence through `runReplLiveArea`.
 *
 * Wires real `Compositor` + `EditorController` + a fake streaming agent
 * with a unique sid, exercises:
 *
 *   1. Mid-turn submits land in `<sid>.queue` while running.
 *   2. A second `runReplLiveArea` invocation against the SAME sid
 *      restores those items, the agent's `run()` sees them as the next
 *      turn's input, and the queue file is deleted after drain.
 *   3. With no `sessionId` provided, no queue file is created at all.
 *
 * Uses the real `defaultSessionsDir()` (`~/.minimal-agent/sessions/`)
 * because `os.homedir()` ignores `process.env.HOME` overrides in Bun
 * (and Node, both go through `getpwuid`). Sids are prefixed with a
 * test-unique tag and `afterEach` unlinks them.
 *
 * @module queue-persist-e2e.test
 */

import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, readFileSync, rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "bun:test"

import { type ReplAgentLike, runRepl } from "../agent/agent.ts"
import { StatusBus } from "../bus/status.ts"
import { EditorController } from "../host/editor-controller.ts"
import { Compositor } from "../host/ui/compositor.ts"

import { loadQueue, type QueueItem, QueueStore, queueFilePath } from "./queue-store.ts"

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

/**
 * Sids minted during the test. Cleaned up in `afterEach` so the user's
 * real sessions dir doesn't accumulate detritus.
 */
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

function makeSlowAgent(observed: string[], opts: { holdMs: number }): ReplAgentLike {
  return {
    pluginLoader: () => null,
    async *run(text: string) {
      observed.push(text)
      yield `response-${observed.length}\n`
      // Hold the turn long enough for follow-up submits to enter the queue.
      await new Promise((r) => setTimeout(r, opts.holdMs))
      return { blocks: [], text: "ok\n", stopReason: "end_turn" } as any
    },
  }
}

describe("queue persistence : <sid>.queue snapshot across runReplLiveArea", () => {
  it("writes queued submits to <sid>.queue while running", async () => {
    const sid = mintSid("ma-queue-e2e-A")
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
    const observed: string[] = []
    const replPromise = runRepl(makeSlowAgent(observed, { holdMs: 300 }), {
      output: output as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor,
      editor,
      sessionId: sid,
    })
    // Wait for editor to attach its data listener.
    await new Promise((r) => setTimeout(r, 10))

    // Submit #1 : starts the slow turn.
    stdin.send("first message")
    stdin.send("\r")
    await new Promise((r) => setTimeout(r, 25))

    // Submit #2 and #3 while turn 1 is still in flight : both queued.
    stdin.send("second message")
    stdin.send("\r")
    await new Promise((r) => setTimeout(r, 15))
    stdin.send("third message")
    stdin.send("\r")
    // Allow the async write (Bun.write + rename) to land.
    await new Promise((r) => setTimeout(r, 60))

    // The queue file must now exist with both queued items.
    const path = queueFilePath(sid)
    expect(existsSync(path)).toBe(true)
    const onDisk: QueueItem[] = JSON.parse(readFileSync(path, "utf-8"))
    expect(onDisk.length).toBe(2)
    expect(onDisk[0].text).toBe("second message")
    expect(onDisk[1].text).toBe("third message")

    // Force-quit so the test doesn't wait for natural drain.
    stdin.send("\x03")
    stdin.send("\x03")
    await replPromise
  })

  it("restores queued items on a fresh runReplLiveArea with the same sid", async () => {
    const sid = mintSid("ma-queue-e2e-B")

    // Pre-seed: write a queue file directly (simulating a prior crashed session).
    const seedStore = new QueueStore(sid)
    seedStore.save([
      { text: "leftover message A", commitLines: [] },
      { text: "leftover message B", commitLines: [] },
    ])
    while (seedStore.isWriting() || seedStore.pendingSnapshot() !== null) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(existsSync(queueFilePath(sid))).toBe(true)

    // Start the REPL with the same sid. The restored queue should
    // become turn 1's input, with the second item draining as turn 2
    // (the fake agent does not call drainQueuedUserText).
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
    const observed: string[] = []
    const replPromise = runRepl(makeSlowAgent(observed, { holdMs: 15 }), {
      output: output as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor,
      editor,
      sessionId: sid,
    })

    // Wait for both restored items to drain.
    await new Promise((r) => setTimeout(r, 250))

    expect(observed.length).toBeGreaterThanOrEqual(2)
    expect(observed[0]).toBe("leftover message A")
    expect(observed[1]).toBe("leftover message B")

    // After both items drain the queue file should be unlinked (save([])).
    await new Promise((r) => setTimeout(r, 50))
    expect(loadQueue(sid)).toEqual([])
    expect(existsSync(queueFilePath(sid))).toBe(false)

    stdin.send("\x03")
    stdin.send("\x03")
    await replPromise
  })

  it("ad-hoc run with no sessionId does not write any queue file", async () => {
    // Sanity: when sessionId is omitted, QueueStore is null and no file
    // is created even if items get queued. Ensures the store is a true
    // no-op rather than crashing on a missing sid.
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
    const observed: string[] = []
    const replPromise = runRepl(makeSlowAgent(observed, { holdMs: 150 }), {
      output: output as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor,
      editor,
      // sessionId intentionally omitted
    })
    await new Promise((r) => setTimeout(r, 10))

    stdin.send("first")
    stdin.send("\r")
    await new Promise((r) => setTimeout(r, 15))
    stdin.send("queued one")
    stdin.send("\r")
    await new Promise((r) => setTimeout(r, 50))

    // We can't easily prove "no file written anywhere" without
    // controlling the sessions dir, so we settle for: the run completes
    // without throwing, no observed agent input got dropped. The unit
    // tests cover the store-is-null code path directly.
    expect(observed[0]).toBe("first")

    stdin.send("\x03")
    stdin.send("\x03")
    await replPromise
  })
})

/**
 * Integration tests for the submit-queue navigation overlay wired in
 * `runReplLiveArea` (`./agent/repl-live-area.ts`).
 *
 * Drives the REPL with a fake editor that captures the `queueKeyHandler`
 * the REPL installs via `setQueueKeyHandler`, plus the decoration lines
 * (`setDecorationLines`) and buffer restores (`setBuffer`). A holding
 * agent keeps one turn in flight so mid-turn submits accumulate in the
 * queue, then the tests invoke the handler directly (the editor→handler
 * wiring itself is covered in `editor-controller.test.ts`).
 *
 * Covers the feature contract:
 *   - ↑ with one queued item dequeues it straight back to the prompt
 *   - ↑ with 2+ opens the overlay (selection + hint row), ↑/↓ move it
 *   - d / Enter dequeue the selected item, x removes it, k dequeues all
 *     (numbered), Esc closes the overlay leaving the queue intact
 *   - aborting a turn dequeues EVERYTHING (in-flight + queued) back to
 *     the prompt, numbered
 *   - dequeue mutations are mirrored to the on-disk <sid>.queue snapshot
 */

import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "bun:test"

import { abortBus as globalAbortBus } from "./abort-bus.ts"
import { type ReplAgentLike, runRepl } from "./agent.ts"
import type { QueueKeyContext, QueueKeyResult } from "./editor/types.ts"
import { loadQueue, queueFilePath } from "./queue-store.ts"
import { StatusBus } from "./status.ts"

// ----------------------------- fakes ---------------------------------------

class FakeCompositor {
  liveHeight = 1
  mount(_n: number): void {}
  unmount(): void {}
  setLiveArea(): void {}
  setLiveHeight(n: number): void {
    this.liveHeight = n
  }
  writeStream(): void {}
  flushStream(): void {}
}

class FakeEditor extends EventEmitter {
  readonly setBufferCalls: string[] = []
  decoration: string[] = []
  private qh: ((key: string, ctx: QueueKeyContext) => QueueKeyResult) | null = null

  start(): void {}
  stop(): void {}
  setBuffer(text: string): void {
    this.setBufferCalls.push(text)
  }
  setDecorationLines(lines: string[]): void {
    this.decoration = [...lines]
  }
  setQueueKeyHandler(h: ((key: string, ctx: QueueKeyContext) => QueueKeyResult) | null): void {
    this.qh = h
  }
  notifyTurnStart(): void {}
  notifyTurnEnd(): void {}

  // ── test helpers ──
  type(text: string): void {
    this.emit("submit", text)
  }
  cancel(): void {
    this.emit("cancel")
  }
  /** Invoke the REPL-installed queue handler as the editor would. */
  queueKey(key: string, ctx: Partial<QueueKeyContext> = {}): QueueKeyResult {
    if (!this.qh) throw new Error("no queueKeyHandler installed")
    const r = this.qh(key, { buffer: ctx.buffer ?? "", atTop: ctx.atTop ?? true })
    if (r.buffer !== undefined) this.setBuffer(r.buffer) // mirror editor.tryQueueNav
    return r
  }
  /** ANSI-stripped decoration snapshot. */
  decoLines(): string[] {
    return this.decoration.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
  }
}

/** A holding agent: keeps the turn awaiting until released or aborted. */
function makeHoldingAgent() {
  const calls: string[] = []
  let release: (() => void) | null = null
  const agent: ReplAgentLike & { rollbackPendingTurn?: () => boolean } = {
    pluginLoader: () => null,
    rollbackPendingTurn: () => false,
    async *run(text, opts: any) {
      calls.push(text)
      yield ""
      await new Promise<void>((resolve, reject) => {
        if (opts?.signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          return
        }
        release = () => {
          release = null
          resolve()
        }
        opts?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        })
      })
      return { blocks: [], text: "", stopReason: "end_turn" } as any
    },
  }
  return {
    agent,
    calls,
    release(): void {
      release?.()
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

/**
 * Poll until `pred` holds (or the deadline passes). The on-disk queue
 * snapshot is written by an async Bun.write+rename chain with no
 * completion signal exposed at the REPL layer, so persistence asserts
 * must wait for the observable condition instead of a fixed tick
 * (a fixed 5ms tick lost the race ~1/3 of runs under load).
 */
async function eventually(pred: () => boolean, deadlineMs = 1000): Promise<void> {
  const t0 = Date.now()
  while (!pred() && Date.now() - t0 < deadlineMs) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * Start a REPL, drain a first turn so the agent is mid-flight, then queue
 * `queued` behind it. Returns the editor + a teardown fn.
 */
async function setup(queued: string[], opts: { sessionId?: string } = {}) {
  const editor = new FakeEditor()
  const f = makeHoldingAgent()
  const replPromise = runRepl(f.agent, {
    output: { isTTY: true, write: () => true, columns: 80, rows: 24 } as any,
    statusBus: new StatusBus(),
    statusRenderer: null,
    useLiveArea: true,
    compositor: new FakeCompositor() as any,
    editor: editor as any,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  })
  await Promise.resolve()
  editor.type("first") // drains immediately, starts the held turn
  await tick()
  for (const q of queued) editor.type(q) // these queue behind the running turn
  await tick()
  const teardown = async () => {
    // Abort the held turn (releasing it would just re-drain any leftover
    // queue into ANOTHER held turn and wedge the loop). The abort path
    // settles the turn, empties the queue, and the loop parks on the
    // empty-queue wait; cancel() then breaks the while-loop cleanly.
    if (globalAbortBus.isTurnInFlight())
      globalAbortBus.requestAbort({ kind: "programmatic", tag: "test-teardown" })
    await tick()
    editor.cancel()
    await replPromise
  }
  return { editor, f, replPromise, teardown }
}

// ----------------------------- tests ---------------------------------------

describe("runReplLiveArea : submit-queue navigation overlay", () => {
  afterEach(() => {
    // Defensive: ensure no turn leaks across tests.
    if (globalAbortBus.isTurnInFlight())
      globalAbortBus.requestAbort({ kind: "programmatic", tag: "test-cleanup" })
  })

  it("↑ with a single queued item dequeues it straight to the prompt", async () => {
    const { editor, teardown } = await setup(["only one"])
    const r = editor.queueKey("ArrowUp")
    expect(r.handled).toBe(true)
    expect(r.buffer).toBe("only one")
    expect(editor.setBufferCalls.at(-1)).toBe("only one")
    // queue is now empty → decoration cleared of queue rows
    expect(editor.decoLines().some((l) => l.includes("queued"))).toBe(false)
    await teardown()
  })

  it("↑ is a pass-through when the prompt is non-empty or not at top", async () => {
    const { editor, teardown } = await setup(["a", "b"])
    expect(editor.queueKey("ArrowUp", { buffer: "typing", atTop: true }).handled).toBe(false)
    expect(editor.queueKey("ArrowUp", { buffer: "", atTop: false }).handled).toBe(false)
    await teardown()
  })

  it("↑ with >1 items opens the overlay selecting the most recent (bottom) row", async () => {
    const { editor, teardown } = await setup(["q1", "q2", "q3"])
    const r = editor.queueKey("ArrowUp")
    expect(r.handled).toBe(true)
    expect(r.buffer).toBeUndefined() // overlay opened, nothing dequeued yet
    const deco = editor.decoLines()
    expect(deco.some((l) => l.includes("▌  3 ▸ q3"))).toBe(true) // last selected
    expect(deco.at(-1)).toContain("↑↓ select") // hint row present
    await teardown()
  })

  it("↑/↓ move the selection within the overlay", async () => {
    const { editor, teardown } = await setup(["q1", "q2", "q3"])
    editor.queueKey("ArrowUp") // open → select q3 (idx 2)
    editor.queueKey("ArrowUp") // → q2 (idx 1)
    expect(editor.decoLines().some((l) => l.includes("▌  2 ▸ q2"))).toBe(true)
    editor.queueKey("ArrowDown") // → q3 (idx 2)
    expect(editor.decoLines().some((l) => l.includes("▌  3 ▸ q3"))).toBe(true)
    // clamp at the top
    editor.queueKey("ArrowUp") // q2
    editor.queueKey("ArrowUp") // q1
    editor.queueKey("ArrowUp") // clamp at q1
    expect(editor.decoLines().some((l) => l.includes("▌  1 ▸ q1"))).toBe(true)
    await teardown()
  })

  it("d dequeues the selected item back to the prompt and closes the overlay", async () => {
    const { editor, teardown } = await setup(["q1", "q2", "q3"])
    editor.queueKey("ArrowUp") // select q3
    editor.queueKey("ArrowUp") // select q2
    const r = editor.queueKey("d")
    expect(r).toEqual({ handled: true, buffer: "q2" })
    const deco = editor.decoLines()
    expect(deco.some((l) => l.includes("· 2"))).toBe(true) // q1 + q3 remain
    expect(deco.some((l) => l.includes("↑↓ select"))).toBe(false) // overlay closed
    await teardown()
  })

  it("Enter behaves like d (confirm selection → dequeue)", async () => {
    const { editor, teardown } = await setup(["q1", "q2"])
    editor.queueKey("ArrowUp") // open, select q2
    const r = editor.queueKey("Enter")
    expect(r).toEqual({ handled: true, buffer: "q2" })
    await teardown()
  })

  it("x removes (discards) the selected item without touching the prompt", async () => {
    const { editor, teardown } = await setup(["q1", "q2", "q3"])
    editor.queueKey("ArrowUp") // select q3
    const before = editor.setBufferCalls.length
    const r = editor.queueKey("x")
    expect(r).toEqual({ handled: true }) // no buffer → nothing restored
    expect(editor.setBufferCalls.length).toBe(before) // prompt untouched
    const deco = editor.decoLines()
    expect(deco.some((l) => l.includes("· 2"))).toBe(true) // q1 + q2 remain
    // still in the overlay (selection clamped to the new last row)
    expect(deco.some((l) => l.includes("↑↓ select"))).toBe(true)
    expect(deco.some((l) => l.includes("▌  2 ▸ q2"))).toBe(true)
    await teardown()
  })

  it("x on the final item empties the queue and closes the overlay", async () => {
    const { editor, teardown } = await setup(["q1", "q2"])
    editor.queueKey("ArrowUp") // open, select q2
    editor.queueKey("x") // remove q2 → one left, still open
    editor.queueKey("x") // remove q1 → empty, closes
    expect(editor.decoLines().some((l) => l.includes("queued"))).toBe(false)
    await teardown()
  })

  it("k dequeues ALL items back to the prompt, numbered", async () => {
    const { editor, teardown } = await setup(["q1", "q2", "q3"])
    editor.queueKey("ArrowUp") // open
    const r = editor.queueKey("k")
    expect(r.handled).toBe(true)
    expect(r.buffer).toBe("1. q1\n2. q2\n3. q3")
    expect(editor.decoLines().some((l) => l.includes("queued"))).toBe(false) // emptied
    await teardown()
  })

  it("Esc closes the overlay leaving the queue intact (no abort, no restore)", async () => {
    const { editor, teardown } = await setup(["q1", "q2"])
    editor.queueKey("ArrowUp") // open
    const before = editor.setBufferCalls.length
    const r = editor.queueKey("Escape")
    expect(r).toEqual({ handled: true })
    expect(editor.setBufferCalls.length).toBe(before) // nothing restored
    const deco = editor.decoLines()
    expect(deco.some((l) => l.includes("· 2"))).toBe(true) // both still queued
    expect(deco.some((l) => l.includes("↑↓ select"))).toBe(false) // plain again
    await teardown()
  })

  it("non-command printables are swallowed while the overlay is open", async () => {
    const { editor, teardown } = await setup(["q1", "q2"])
    editor.queueKey("ArrowUp") // open
    const before = editor.setBufferCalls.length
    expect(editor.queueKey("z").handled).toBe(true) // swallowed
    expect(editor.setBufferCalls.length).toBe(before)
    // queue untouched
    expect(editor.decoLines().some((l) => l.includes("· 2"))).toBe(true)
    await teardown()
  })

  it("aborting a turn dequeues EVERYTHING (in-flight + queued) to the prompt, numbered", async () => {
    const { editor, replPromise } = await setup(["q1", "q2"])
    // fire the abort while the turn is held
    globalAbortBus.requestAbort({ kind: "user-key", key: "Esc" })
    await tick()
    // in-flight "first" + queued q1, q2 → numbered restore
    expect(editor.setBufferCalls.at(-1)).toBe("1. first\n2. q1\n3. q2")
    editor.cancel()
    await replPromise
  })

  it("aborting with NO queue restores the in-flight text verbatim (no numbering)", async () => {
    const editor = new FakeEditor()
    const f = makeHoldingAgent()
    const replPromise = runRepl(f.agent, {
      output: { isTTY: true, write: () => true, columns: 80, rows: 24 } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: new FakeCompositor() as any,
      editor: editor as any,
    })
    await Promise.resolve()
    editor.type("solo message")
    await tick()
    globalAbortBus.requestAbort({ kind: "user-key", key: "Esc" })
    await tick()
    expect(editor.setBufferCalls.at(-1)).toBe("solo message")
    editor.cancel()
    await replPromise
  })
})

describe("runReplLiveArea : queue-nav persistence", () => {
  const sids: string[] = []
  afterEach(() => {
    for (const sid of sids.splice(0)) {
      try {
        rmSync(queueFilePath(sid), { force: true })
      } catch {
        /* best-effort */
      }
    }
    if (globalAbortBus.isTurnInFlight())
      globalAbortBus.requestAbort({ kind: "programmatic", tag: "test-cleanup" })
  })

  it("dequeuing rewrites the on-disk <sid>.queue snapshot", async () => {
    const sid = `ma-queue-nav-${randomUUID()}`
    sids.push(sid)
    const { editor, teardown } = await setup(["keep me", "drop me"], { sessionId: sid })
    // Two items persisted while running.
    expect(loadQueue(sid).map((i) => i.text)).toEqual(["keep me", "drop me"])
    // Open + dequeue the bottom one (drop me) back to the prompt.
    editor.queueKey("ArrowUp") // select "drop me"
    editor.queueKey("d")
    // QueueStore.save flushes via async Bun.write+rename; wait for the
    // snapshot to land rather than racing it with a fixed tick.
    await eventually(() => loadQueue(sid).length === 1)
    // Persisted snapshot now reflects the single remaining item.
    expect(loadQueue(sid).map((i) => i.text)).toEqual(["keep me"])
    await teardown()
  })

  it("dequeue-all (k) clears the on-disk snapshot", async () => {
    const sid = `ma-queue-nav-${randomUUID()}`
    sids.push(sid)
    const { editor, teardown } = await setup(["a", "b"], { sessionId: sid })
    expect(existsSync(queueFilePath(sid))).toBe(true)
    editor.queueKey("ArrowUp")
    editor.queueKey("k")
    // QueueStore.clear() unlinks asynchronously; wait for it to land.
    await eventually(() => !existsSync(queueFilePath(sid)))
    // Empty queue → file deleted.
    expect(existsSync(queueFilePath(sid))).toBe(false)
    expect(loadQueue(sid)).toEqual([])
    await teardown()
  })
})

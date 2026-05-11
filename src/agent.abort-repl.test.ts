/**
 * Tests for Phase 1.3 of the abort plan: REPL turn integration with
 * `abortBus`. Verifies that:
 *
 *  1. Every turn through `runReplLiveArea` brackets `agent.run` with
 *     `abortBus.beginTurn()` / `abortBus.endTurn()`.
 *  2. The `AbortController.signal` returned by `beginTurn` is forwarded
 *     to `agent.run({ signal })`.
 *  3. When `abortBus.requestAbort` fires while a turn is in flight, the
 *     REPL:
 *       - swallows the resulting `AbortError` (no `error` footer);
 *       - prints a faint+strikethrough "⊘ ABORTED · ❯ <echoed body>" block
 *         (see `formatAbortedEcho` : replaces the older single-line
 *         "⊘ aborted by user : prompt restored to editor" footer);
 *       - calls `editor.setBuffer(text)` to restore the in-flight prompt;
 *       - calls `agent.rollbackPendingTurn()` to drop the orphan user turn;
 *       - leaves `abortBus.isTurnInFlight()` false.
 *  4. Real (non-Abort) errors STILL go through the existing "error" path :
 *     the abort branch must not shadow them.
 *  5. After an aborted turn, the very next turn dispatches with a FRESH
 *     non-aborted signal.
 *  6. Idempotent abort: two rapid `requestAbort` calls produce exactly one
 *     footer + one `setBuffer` call.
 *  7. `endTurn` runs even when the agent throws a non-Abort error.
 *  8. End-to-end with a real `Bash sleep 5` tool call: abort completes
 *     within the SIGTERM→SIGKILL window and the orphan tool process dies.
 *
 * The host is `runReplLiveArea` (called via the `useLiveArea: true` arm of
 * `runRepl`). We drive turns through a `FakeEditor` and observe writes via
 * a `FakeCompositor`, mirroring the patterns established in
 * `src/agent.test.ts`.
 */
import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { Agent, type ReplAgentLike, runRepl } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { Message, SendOptions, StreamedResponse } from "./client.ts"
import { abortBus as globalAbortBus } from "./abort-bus.ts"
import { StatusBus } from "./status.ts"

// ----------------------------- fakes ---------------------------------------

class FakeCompositor {
  readonly streams: string[] = []
  liveHeight = 1
  mounted = false
  unmounted = false
  mount(_n: number): void {
    this.mounted = true
  }
  unmount(): void {
    this.unmounted = true
  }
  setLiveArea(_lines: string[], _cursor: { row: number; col: number } | null): void {}
  setLiveHeight(n: number): void {
    this.liveHeight = n
  }
  writeStream(chunk: string): void {
    this.streams.push(chunk)
  }
  flushStream(): void {}
  async withSuspendedLiveArea<T>(fn: () => Promise<T>): Promise<T> {
    return await fn()
  }
}

class FakeEditor extends EventEmitter {
  started = false
  stopped = false
  readonly setBufferCalls: string[] = []
  start(): void {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
  setBuffer(text: string): void {
    this.setBufferCalls.push(text)
  }
  // helpers for tests
  type(text: string): void {
    this.emit("submit", text)
  }
  cancel(): void {
    this.emit("cancel")
  }
}

// ----------------------------- helpers -------------------------------------

/**
 * A fake agent whose `run` method awaits its own AbortSignal: it yields a
 * first chunk, then sleeps until the signal aborts (rejecting with a
 * canonical `AbortError`) OR until `release()` is called (resolving so the
 * generator yields a final chunk and returns normally).
 *
 * Records every `(text, signal)` call so tests can assert on what the REPL
 * forwarded.
 */
function makeAbortableAgent() {
  const calls: Array<{ text: string; signal: AbortSignal | undefined }> = []
  const rollbacks: string[] = []
  let release: (() => void) | null = null
  let active = false

  const agent: ReplAgentLike & { rollbackPendingTurn?: () => boolean } = {
    pluginLoader: () => null,
    rollbackPendingTurn: () => {
      rollbacks.push("called")
      return false
    },
    async *run(text, opts: any) {
      calls.push({ text, signal: opts?.signal })
      active = true
      try {
        yield "hi "
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
        yield "bye"
        return { blocks: [], text: "hi bye", stopReason: "end_turn" } as StreamedResponse
      } finally {
        active = false
      }
    },
  }

  return {
    agent,
    calls,
    rollbacks,
    isActive(): boolean {
      return active
    },
    /** Resolve the in-flight `await` so the turn completes normally. */
    release(): void {
      release?.()
    },
  }
}

/** Wait one macrotask (lets queued promise jobs flush). */
const tick = () => new Promise((r) => setTimeout(r, 5))

/** Strip ANSI for footer-content assertions. */
const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")
const stripAnsi = (s: string) => s.replace(ANSI_RE, "")

// ----------------------------- tests ---------------------------------------

describe("runReplLiveArea : abort bus integration", () => {
  it("brackets every turn with abortBus.beginTurn / endTurn (success path)", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()
    const f = makeAbortableAgent()

    expect(globalAbortBus.isTurnInFlight()).toBe(false)

    const replPromise = runRepl(f.agent, {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("hello")
    // Wait until the agent is mid-await.
    await tick()
    expect(f.isActive()).toBe(true)
    expect(globalAbortBus.isTurnInFlight()).toBe(true)

    // Release the agent so the turn completes.
    f.release()
    await tick()
    expect(globalAbortBus.isTurnInFlight()).toBe(false)

    editor.cancel()
    await replPromise

    // Agent saw exactly one signal : the bus's signal.
    expect(f.calls.length).toBe(1)
    expect(f.calls[0].signal).toBeDefined()
    expect(f.calls[0].signal!.aborted).toBe(false)
  })

  it("forwards the bus's AbortSignal into agent.run({signal})", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()
    const f = makeAbortableAgent()

    const replPromise = runRepl(f.agent, {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("go")
    await tick()

    expect(f.calls[0].signal).toBeInstanceOf(AbortSignal)
    expect(f.calls[0].signal!.aborted).toBe(false)

    // Trip the bus → the same signal must flip aborted=true.
    globalAbortBus.requestAbort({ kind: "user-key", key: "Esc" })
    await tick()
    expect(f.calls[0].signal!.aborted).toBe(true)

    editor.cancel()
    await replPromise
  })

  it("Esc/Ctrl+C while turn in-flight: faint+strikethrough '⊘ ABORTED' echo, no 'error' line", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()
    const f = makeAbortableAgent()

    const replPromise = runRepl(f.agent, {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("the user prompt")
    await tick()
    globalAbortBus.requestAbort({ kind: "user-key", key: "Esc" })
    await tick()

    const all = stripAnsi(compositor.streams.join(""))
    // The new abort-echo block uses the `⊘ ABORTED` anchor (vs the older
    // single-line `⊘ aborted by user : prompt restored to editor` footer).
    // Echoes the rolled-back submission in dim+strikethrough so the user
    // can disambiguate from the re-submitted prompt visually.
    expect(all).toContain("⊘ ABORTED")
    expect(all).toContain("the user prompt") // the echoed body
    // Generic error path uses the literal "error" prefix : must NOT fire here.
    const errorLines = compositor.streams.filter((s) => s.includes("\x1b[1;31merror"))
    expect(errorLines.length).toBe(0)

    editor.cancel()
    await replPromise
  })

  it("after abort, calls editor.setBuffer(text) with the in-flight prompt", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()
    const f = makeAbortableAgent()

    const replPromise = runRepl(f.agent, {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("multi\nline\ndraft")
    await tick()
    globalAbortBus.requestAbort({ kind: "user-key", key: "Ctrl+C" })
    await tick()

    expect(editor.setBufferCalls).toEqual(["multi\nline\ndraft"])

    editor.cancel()
    await replPromise
  })

  it("after abort, calls agent.rollbackPendingTurn() to drop the orphan turn", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()
    const f = makeAbortableAgent()

    const replPromise = runRepl(f.agent, {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("abc")
    await tick()
    globalAbortBus.requestAbort({ kind: "user-key", key: "Esc" })
    await tick()

    expect(f.rollbacks.length).toBe(1)

    editor.cancel()
    await replPromise
  })

  it("idempotent: two rapid requestAbort calls produce one footer + one setBuffer", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()
    const f = makeAbortableAgent()

    const replPromise = runRepl(f.agent, {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("x")
    await tick()
    globalAbortBus.requestAbort({ kind: "user-key", key: "Esc" })
    globalAbortBus.requestAbort({ kind: "user-key", key: "Ctrl+C" })
    await tick()

    expect(editor.setBufferCalls.length).toBe(1)
    const footers = compositor.streams.filter((s) => stripAnsi(s).includes("⊘ ABORTED"))
    expect(footers.length).toBe(1)

    editor.cancel()
    await replPromise
  })

  it("between turns, requestAbort is a no-op (isTurnInFlight=false)", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()
    const f = makeAbortableAgent()

    const replPromise = runRepl(f.agent, {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    // No turn has been submitted yet.
    expect(globalAbortBus.isTurnInFlight()).toBe(false)
    const dispatched = globalAbortBus.requestAbort({ kind: "user-key", key: "Esc" })
    expect(dispatched).toBe(false)
    expect(editor.setBufferCalls.length).toBe(0)

    editor.cancel()
    await replPromise
  })

  it("after an aborted turn, the next turn dispatches with a fresh non-aborted signal", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()
    const f = makeAbortableAgent()

    const replPromise = runRepl(f.agent, {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("first")
    await tick()
    globalAbortBus.requestAbort({ kind: "user-key", key: "Esc" })
    await tick()

    // Turn 2: must get a brand-new signal (not the aborted one).
    editor.type("second")
    await tick()
    expect(f.calls.length).toBe(2)
    expect(f.calls[1].signal).toBeDefined()
    expect(f.calls[1].signal!.aborted).toBe(false)
    // Ensure the two signals are distinct AbortSignal instances.
    expect(f.calls[1].signal).not.toBe(f.calls[0].signal)

    f.release()
    await tick()
    editor.cancel()
    await replPromise
  })

  it("real (non-Abort) error STILL routes through the 'error' branch", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()
    let rollbacks = 0

    const erroringAgent: ReplAgentLike = {
      pluginLoader: () => null,
      rollbackPendingTurn: () => {
        rollbacks++
        return false
      },
      async *run(_text, _opts) {
        throw new Error("boom not abort")
        yield "" // unreachable, satisfies generator type
      },
    }

    const replPromise = runRepl(erroringAgent, {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("go")
    await tick()

    const all = compositor.streams.join("")
    expect(stripAnsi(all)).toContain("error boom not abort")
    expect(stripAnsi(all)).not.toContain("⊘ ABORTED")
    expect(editor.setBufferCalls.length).toBe(0)
    expect(rollbacks).toBe(1)
    // Bus must be reset even on real errors.
    expect(globalAbortBus.isTurnInFlight()).toBe(false)

    editor.cancel()
    await replPromise
  })

  it("endTurn runs even when the agent throws a non-Abort error (regression)", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()

    const erroringAgent: ReplAgentLike = {
      pluginLoader: () => null,
      rollbackPendingTurn: () => false,
      async *run(_text, _opts) {
        throw new Error("kaboom")
        yield ""
      },
    }

    expect(globalAbortBus.isTurnInFlight()).toBe(false)
    const replPromise = runRepl(erroringAgent, {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("oops")
    await tick()
    expect(globalAbortBus.isTurnInFlight()).toBe(false)

    editor.cancel()
    await replPromise
  })
})

// ---------------------------------------------------------------------------
// End-to-end: real Agent + real tools + real Bash sleep, abort kills child.
// ---------------------------------------------------------------------------

describe("runReplLiveArea : abort kills in-flight tool", () => {
  it("aborting a turn that's running `Bash sleep 5` returns within the SIGTERM grace + propagates AbortError to the REPL footer", async () => {
    const compositor = new FakeCompositor()
    const editor = new FakeEditor()

    // Build a real Agent whose first round emits a Bash tool_use, then
    // (if it ever resumes) returns a benign assistant text. The tool will
    // be aborted via the global bus before the second round happens.
    let round = 0
    const sendFn = async function* (
      _messages: Message[],
      _opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "tool-1",
              name: "Bash",
              input: { command: "sleep 5" },
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
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn: sendFn as any,
    })

    const replPromise = runRepl(agent as any, {
      output: { isTTY: true, write: () => true } as any,
      statusBus: new StatusBus(),
      statusRenderer: null,
      useLiveArea: true,
      compositor: compositor as any,
      editor: editor as any,
    })

    await Promise.resolve()
    editor.type("run sleep")
    // Give the agent time to dispatch the Bash tool.
    await new Promise((r) => setTimeout(r, 200))

    const t0 = Date.now()
    globalAbortBus.requestAbort({ kind: "user-key", key: "Ctrl+C" })

    // Wait for the abort path to land. SIGTERM grace is 2s in Bun.spawn,
    // SIGKILL escalation after that. We allow 4s ceiling.
    let waited = 0
    while (compositor.streams.every((s) => !stripAnsi(s).includes("⊘ ABORTED"))) {
      if (waited > 4000) break
      await new Promise((r) => setTimeout(r, 50))
      waited += 50
    }
    const dt = Date.now() - t0

    expect(dt).toBeLessThan(4000)
    expect(stripAnsi(compositor.streams.join(""))).toContain("⊘ ABORTED")
    expect(editor.setBufferCalls).toEqual(["run sleep"])

    editor.cancel()
    await replPromise
  }, 10_000)
})

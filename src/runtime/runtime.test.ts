/**
 * `createRuntime` / `openSession` / `resumeSession` (spec v2 section 2.3,
 * S47) with a fake transport. Multi-session isolation, event + diagnostic
 * ordering through `session.run`, and resume-after-crash (S50).
 *
 * @module runtime/runtime.test
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import type { SessionEntry } from "../session/event-log.ts"

import { createRuntime } from "./runtime.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

const textOk = (text: string): StreamedResponse => ({
  blocks: [{ type: "text", text }],
  text,
  stopReason: "end_turn",
})

/** A transport that always answers `text` with no delay. */
function staticTransport(text: string): TransportFn {
  return async function* () {
    return textOk(text)
  }
}

/** A transport that fails `failures` times with a transient error, then answers `text`. */
function flakyTransport(failures: number, text: string): TransportFn & { calls: () => number } {
  let calls = 0
  const fn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    calls++
    if (calls <= failures) {
      throw Object.assign(new Error(`transient ${calls}`), { errorClass: "transient" })
    }
    return textOk(text)
  }
  return Object.assign(fn, { calls: () => calls })
}

/** A transport that hangs until its `AbortSignal` fires, then rejects. */
function hangingTransport(): TransportFn {
  return async function* (opts) {
    await new Promise<void>((_resolve, reject) => {
      const { signal } = opts
      if (signal?.aborted) {
        reject(new Error("aborted-for-test"))
        return
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted-for-test")), {
        once: true,
      })
    })
    return textOk("unreachable")
  }
}

/** Drain an `AsyncIterable<SessionEntry>` to an array. Rethrows a run failure after collecting. */
async function collect(entries: AsyncIterable<SessionEntry>): Promise<SessionEntry[]> {
  const out: SessionEntry[] = []
  for await (const entry of entries) out.push(entry)
  return out
}

const tempDirs: string[] = []
function tempSessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ma-runtime-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("createRuntime / openSession", () => {
  it("runs a plain, tool-free turn with no caller-supplied collaborators", async () => {
    const runtime = createRuntime()
    const session = runtime.openSession({ auth: AUTH, model: "m1", sendFn: staticTransport("hi") })

    const entries = await collect(session.run("hello"))

    expect(session.id).toMatch(/^[0-9a-f-]{36}$/)
    const kinds = entries.filter((e) => e.ch === "event").map((e) => e.data.type)
    expect(kinds).toEqual([
      "user_message",
      "turn_started",
      "item_started",
      "item_completed",
      "turn_completed",
      "run_finished",
    ])
    const turnCompleted = entries.find((e) => e.ch === "event" && e.data.type === "turn_completed")
    expect(turnCompleted).toBeDefined()
    runtime.close()
  })

  it("keeps two sessions fully isolated: distinct ids, logs, and diagnostic sessionId", async () => {
    const runtime = createRuntime()
    const sessionA = runtime.openSession({
      auth: AUTH,
      model: "a",
      sendFn: flakyTransport(1, "from-a"),
    })
    const sessionB = runtime.openSession({
      auth: AUTH,
      model: "b",
      sendFn: staticTransport("from-b"),
    })
    expect(sessionA.id).not.toBe(sessionB.id)

    const [entriesA, entriesB] = await Promise.all([
      collect(sessionA.run("go")),
      collect(sessionB.run("go")),
    ])

    for (const entry of entriesA) expect(entry.sessionId).toBe(sessionA.id)
    for (const entry of entriesB) expect(entry.sessionId).toBe(sessionB.id)

    // Session A's flaky transport recovered once: a diag entry (api.retry)
    // interleaved with its event entries, in increasing seq order.
    const diagA = entriesA.filter((e) => e.ch === "diag")
    expect(diagA.length).toBeGreaterThan(0)
    expect(diagA.some((e) => e.data.code === "api.retry")).toBe(true)
    for (let i = 1; i < entriesA.length; i++)
      expect(entriesA[i].seq).toBeGreaterThan(entriesA[i - 1].seq)

    // Session B never failed: no diagnostics, just the plain event sequence.
    expect(entriesB.some((e) => e.ch === "diag")).toBe(false)

    // The two sessions' event logs never leak into each other: re-reading
    // session A's own log from seq 0 reproduces exactly its entries.
    const replayed: SessionEntry[] = []
    sessionA.subscribe((e) => replayed.push(e), { fromSeq: 0 })
    expect(replayed).toEqual(entriesA)

    runtime.close()
  })

  it("answers a pending ask via its default askUser port", async () => {
    // No preflight ask fires in a plain turn; this exercises the same
    // registry `session.answer` resolves, through the port the session
    // actually built (see `host-ports-defaults.test.ts` for the registry's
    // own resolve/decline semantics in isolation).
    const runtime = createRuntime()
    const session = runtime.openSession({ auth: AUTH, model: "m", sendFn: staticTransport("ok") })
    expect(session.answer("no-such-ask", "x")).toBe(false)
    await collect(session.run("go"))
    runtime.close()
  })

  it("aborts the in-progress run via session.abort()", async () => {
    const runtime = createRuntime()
    const session = runtime.openSession({ auth: AUTH, model: "m", sendFn: hangingTransport() })

    const entries: SessionEntry[] = []
    const draining = (async () => {
      try {
        for await (const entry of session.run("go")) entries.push(entry)
      } catch {
        // The aborted run's generator rethrows after emitting error+run_finished.
      }
    })()

    // Let the run reach its hanging transport call before aborting.
    await new Promise((resolve) => setTimeout(resolve, 10))
    session.abort("test abort")
    await draining

    const types = entries.filter((e) => e.ch === "event").map((e) => e.data.type)
    expect(types).toContain("error")
    expect(types).toContain("run_finished")
    const finished = entries.find((e) => e.ch === "event" && e.data.type === "run_finished")
    expect(finished).toMatchObject({ data: { outcome: "aborted" } })

    runtime.close()
  })

  it("rejects a second concurrent run on the same session", () => {
    const runtime = createRuntime()
    const session = runtime.openSession({ auth: AUTH, model: "m", sendFn: hangingTransport() })
    const first = session.run("go")
    // Starting iteration kicks off the drive; a second run() call before it
    // finishes is rejected synchronously.
    void collect(first).catch(() => {})
    expect(() => session.run("again")).toThrow(/already has a run in progress/)
    session.abort()
    runtime.close()
  })

  it("rejects use of a closed runtime or a closed session", async () => {
    const runtime = createRuntime()
    const session = runtime.openSession({ auth: AUTH, model: "m", sendFn: staticTransport("ok") })
    await collect(session.run("go"))
    runtime.close()
    expect(() => session.run("again")).toThrow(/closed/)
    expect(() => runtime.openSession({ auth: AUTH, model: "m" })).toThrow(/closed/)
  })
})

describe("createRuntime / resumeSession (S50)", () => {
  it("continues an interrupted turn at its last round checkpoint", async () => {
    const dir = tempSessionsDir()
    const runtime = createRuntime()

    let calls = 0
    const crashingTransport: TransportFn = async function* () {
      calls++
      if (calls === 1) {
        return {
          blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          text: "",
          stopReason: "tool_use",
        }
      }
      throw new Error("process killed")
    }

    const id = "ba0ad20f-1111-4111-8111-111111111111"
    const session = runtime.openSession({
      id,
      auth: AUTH,
      model: "m",
      sendFn: crashingTransport,
      toolRegistry: { list: () => [{ name: "Bash", description: "", input_schema: {} }] },
      toolExecutor: { execute: async () => ({ content: "ok", isError: false }) },
      persist: { dir },
    })

    await expect(collect(session.run("go"))).rejects.toThrow("process killed")
    expect(calls).toBe(2)
    runtime.close()

    // A fresh runtime (as a real restart would be): reopen the session from
    // its persisted history and resume the interrupted turn.
    const runtimeAfterRestart = createRuntime()
    let resumedCalls = 0
    const resumedTransport: TransportFn = async function* () {
      resumedCalls++
      return textOk("all done")
    }
    const resumed = runtimeAfterRestart.resumeSession(id, {
      auth: AUTH,
      sendFn: resumedTransport,
      toolRegistry: { list: () => [{ name: "Bash", description: "", input_schema: {} }] },
      toolExecutor: { execute: async () => ({ content: "ok", isError: false }) },
      persist: { dir },
    })

    const entries = await collect(resumed.run("", { resume: true }))
    // Exactly one more send: the round the crash cut off. The tool round is
    // not replayed.
    expect(resumedCalls).toBe(1)
    const finished = entries.find((e) => e.ch === "event" && e.data.type === "run_finished")
    expect(finished).toMatchObject({ data: { outcome: "completed" } })

    runtimeAfterRestart.close()
  })

  it("keeps the event log in memory when eventLogPath is null", async () => {
    const dir = tempSessionsDir()
    const id = "44444444-4444-4444-8444-444444444444"
    const runtime = createRuntime()
    const session = runtime.openSession({
      id,
      auth: AUTH,
      model: "m",
      sendFn: staticTransport("first"),
      persist: { dir },
    })
    await collect(session.run("go"))
    runtime.close()
    const eventsFile = join(dir, `${id}.events.jsonl`)
    rmSync(eventsFile, { force: true })

    const runtimeAfterRestart = createRuntime()
    const resumed = runtimeAfterRestart.resumeSession(id, {
      auth: AUTH,
      sendFn: staticTransport("second"),
      persist: { dir },
      eventLogPath: null,
    })
    const entries = await collect(resumed.run("again"))
    expect(entries.some((e) => e.ch === "event" && e.data.type === "run_finished")).toBe(true)
    // No durable sidecar: a host that does not want one gets none.
    expect(existsSync(eventsFile)).toBe(false)
    runtimeAfterRestart.close()
  })

  it("throws for an id with no persisted history", () => {
    const dir = tempSessionsDir()
    const runtime = createRuntime()
    expect(() =>
      runtime.resumeSession("no-such-session", { auth: AUTH, persist: { dir } }),
    ).toThrow()
    runtime.close()
  })

  it("does not re-run an already-completed round after the turn fully settled", async () => {
    // Regression: round 1 was a tool call (checkpointed), round 2 answered
    // with plain text and completed the turn. Nothing crashed. A later
    // `resumeSession` + `run(text, { resume: true })` — e.g. a host that
    // always resumes a reopened session rather than tracking liveness
    // itself — must start a fresh turn, not replay round 2's already
    // delivered reply as if the turn had been cut short at round 1.
    const dir = tempSessionsDir()
    const runtime = createRuntime()

    let calls = 0
    const transport: TransportFn = async function* () {
      calls++
      if (calls === 1) {
        return {
          blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          text: "",
          stopReason: "tool_use",
        }
      }
      return textOk("first turn done")
    }

    const id = "f730cc8c-3333-4333-8333-333333333333"
    const session = runtime.openSession({
      id,
      auth: AUTH,
      model: "m",
      sendFn: transport,
      toolRegistry: { list: () => [{ name: "Bash", description: "", input_schema: {} }] },
      toolExecutor: { execute: async () => ({ content: "ok", isError: false }) },
      persist: { dir },
    })

    const firstEntries = await collect(session.run("go"))
    expect(calls).toBe(2)
    const firstFinished = firstEntries.find(
      (e) => e.ch === "event" && e.data.type === "run_finished",
    )
    expect(firstFinished).toMatchObject({ data: { outcome: "completed" } })
    runtime.close()

    const runtimeAfterRestart = createRuntime()
    let resumedCalls = 0
    const resumedTransport: TransportFn = async function* () {
      resumedCalls++
      return textOk("second turn done")
    }
    const resumed = runtimeAfterRestart.resumeSession(id, {
      auth: AUTH,
      sendFn: resumedTransport,
      toolRegistry: { list: () => [{ name: "Bash", description: "", input_schema: {} }] },
      toolExecutor: { execute: async () => ({ content: "ok", isError: false }) },
      persist: { dir },
    })

    const resumedEntries = await collect(resumed.run("go again", { resume: true }))
    // A fresh turn (round 1), not a continuation of the already-finished
    // turn's round 2: exactly one send, and `turn_started` reports round 1.
    expect(resumedCalls).toBe(1)
    const turnStarted = resumedEntries.filter(
      (e) => e.ch === "event" && e.data.type === "turn_started",
    )
    expect(
      turnStarted.map((e) =>
        e.ch === "event" && e.data.type === "turn_started" ? e.data.turn : -1,
      ),
    ).toEqual([1])
    const userMessages = resumedEntries.filter(
      (e) => e.ch === "event" && e.data.type === "user_message",
    )
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0]).toMatchObject({ data: { text: "go again" } })

    runtimeAfterRestart.close()
  })
})

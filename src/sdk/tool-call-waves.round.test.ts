/**
 * The wave scheduler with the real tool round (`ToolExecutorAdapter` to
 * `executeToolRound`), a real `SessionStore` on disk and a real
 * `BlobStore` (SPEC D4, D9, X3, section 7). A loader stub gives one plugin
 * tool `Look` with the concurrency-safe flag. Each run ends when the test
 * opens its gate. No timers in the code under test.
 *
 * @module sdk/tool-call-waves.round.test
 */

import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { closeInterruptedToolCalls } from "../agent/history-repair.ts"
import type { ToolViewEvent } from "../agent/tool-view-port.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { ToolExecutorAdapter } from "../loops/assemble.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import { BlobStore } from "../session/blob-store.ts"
import { lastTurnRoundCheckpoint, loadSession } from "../session/session-restore.ts"
import { SessionStore } from "../session/session-store.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import type { AgentEvent } from "./events.ts"
import { type LifecyclePort, NOOP_LIFECYCLE } from "./lifecycle.ts"
import { runToolCalls, type ToolCallHost } from "./tool-calls.ts"

/** Let all queued jobs run. */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((res) => setTimeout(res, 0))
}

function look(id: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: "tool_use", id, name: "Look", input }
}

interface Rig {
  host: ToolCallHost
  store: SessionStore
  dir: string
  sid: string
  blobDir: string
  events: AgentEvent[]
  view: string[]
  starts: string[]
  blobWrites: string[]
  blobPeak: { value: number }
  release(id: string): void
  releaseAll(): void
}

interface RigOptions {
  cap?: number
  lifecycle?: LifecyclePort
  /** Throw from the session store when it saves this id. */
  failSaveOf?: string
  /** Body size of each tool output (a large body makes a blob). */
  bodyBytes?: number
  maxBlobs?: number
}

function rig(calls: readonly ToolUseBlock[], opts: RigOptions = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "ma-wave-round-"))
  const sid = `wave-${Math.random().toString(36).slice(2, 8)}`
  const store = SessionStore.open({
    sid,
    model: "test-model",
    cwd: dir,
    systemHash: "h",
    toolsHash: "h",
    agentVersion: "test",
    dir,
  })
  // The log of a run as in `sdk/resume-stop-cases.test.ts`: round 1 done
  // and checkpointed, round 2 asks for `calls`.
  store.appendUser("go")
  store.appendAssistant([{ type: "tool_use", id: "t0", name: "Look", input: {} }], "tool_use")
  store.appendToolResult({ type: "tool_result", tool_use_id: "t0", content: "ok" })
  store.appendRoundCheckpoint({ round: 1, maxTokensStreak: 0, interruptedStreak: 0 })
  store.appendAssistant([...calls], "tool_use")
  if (opts.failSaveOf !== undefined) {
    const save = store.appendToolResult.bind(store)
    store.appendToolResult = (block, ...rest) => {
      if (block.tool_use_id === opts.failSaveOf) throw new Error("disk full")
      save(block, ...rest)
    }
  }
  const blobDir = join(dir, `${sid}.blobs`)
  const blobStore = new BlobStore({
    sid,
    dir: blobDir,
    config: { minBytesToPersist: 1, maxBlobsPerSession: opts.maxBlobs ?? 100 },
  })
  const blobWrites: string[] = []
  const blobPeak = { value: 0 }
  let blobInFlight = 0
  const write = blobStore.writeAsync.bind(blobStore)
  blobStore.writeAsync = async (id, raw) => {
    blobInFlight++
    blobPeak.value = Math.max(blobPeak.value, blobInFlight)
    blobWrites.push(id)
    try {
      return await write(id, raw)
    } finally {
      blobInFlight--
    }
  }
  const gates = new Map<string, { promise: Promise<void>; open(): void }>()
  let all = false
  const gateOf = (id: string) => {
    let g = gates.get(id)
    if (!g) {
      let open = () => {}
      const promise = new Promise<void>((res) => {
        open = res
      })
      g = { promise, open }
      gates.set(id, g)
      if (all) g.open()
    }
    return g
  }
  const starts: string[] = []
  const body = "x".repeat(opts.bodyBytes ?? 8)
  const loader = {
    hasTool: (name: string) => name === "Look",
    // The manifest flag and a per-input export: `serial: true` -> not safe.
    toolConcurrency: (name: string) =>
      name === "Look"
        ? { flag: true, perInput: (input: Record<string, unknown>) => input.serial !== true }
        : undefined,
    dispatch: async (
      trigger: { tool_use_id: string; input: Record<string, unknown> },
      _cwd: string,
      signal?: AbortSignal,
    ) => {
      starts.push(trigger.tool_use_id)
      await Promise.race([
        gateOf(trigger.tool_use_id).promise,
        new Promise<void>((res) => signal?.addEventListener("abort", () => res())),
      ])
      return {
        kind: "tool_result" as const,
        content: signal?.aborted
          ? `aborted ${trigger.tool_use_id}`
          : `${trigger.tool_use_id} ${body}`,
        is_error: false,
      }
    },
    getExtraTools: () => [],
    getToolAliases: () => new Map<string, string>(),
  } as unknown as PluginLoader
  const view: string[] = []
  const executor = new ToolExecutorAdapter({
    loader,
    modeManager: null,
    blobStore,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
    store,
    lifecycle: opts.lifecycle ?? NOOP_LIFECYCLE,
    toolView: {
      onToolEvent(e: ToolViewEvent) {
        if (e.type === "started" || e.type === "plugin_result" || e.type === "outcome") {
          view.push(`${e.type}:${e.tool.id}`)
        }
      },
    },
  })
  const events: AgentEvent[] = []
  const host: ToolCallHost = {
    executor,
    persistence: null,
    emit: (e) => events.push(e),
    wantsToolOutput: false,
    now: () => 0,
    maxConcurrentToolCalls: opts.cap ?? 10,
  }
  return {
    host,
    store,
    dir,
    sid,
    blobDir,
    events,
    view,
    starts,
    blobWrites,
    blobPeak,
    release: (id) => gateOf(id).open(),
    releaseAll: () => {
      all = true
      for (const g of gates.values()) g.open()
    },
  }
}

/** The ids of the tool_result records on disk, in file order. */
function savedIds(r: Rig): string[] {
  return loadSession(r.sid, r.dir).records.flatMap((rec) =>
    rec.kind === "tool_result" && rec.tool_use_id !== "t0" ? [rec.tool_use_id] : [],
  )
}

function resultIds(events: AgentEvent[]): string[] {
  return events.flatMap((e) => (e.type === "tool_result" ? [e.id] : []))
}

describe("wave scheduler with the real tool round", () => {
  test("call 1 ends last: records on disk and SDK events in call order, view in end order", async () => {
    const calls = [look("a"), look("b"), look("c")]
    const r = rig(calls)
    const done = runToolCalls(r.host, calls, undefined)
    await flush()
    expect(r.starts).toEqual(["a", "b", "c"])
    r.release("c")
    await flush()
    r.release("b")
    await flush()
    expect(savedIds(r)).toEqual([])
    r.release("a")
    const results = await done
    expect(results.map((x) => x.tool_use_id)).toEqual(["a", "b", "c"])
    expect(savedIds(r)).toEqual(["a", "b", "c"])
    expect(resultIds(r.events)).toEqual(["a", "b", "c"])
    expect(r.view.filter((v) => v.startsWith("plugin_result"))).toEqual([
      "plugin_result:c",
      "plugin_result:b",
      "plugin_result:a",
    ])
    // Decision 3': the outcome of each call shows when its run ends.
    expect(r.view.filter((v) => v.startsWith("outcome"))).toEqual([
      "outcome:c",
      "outcome:b",
      "outcome:a",
    ])
  })

  test("blob writes run one at a time in end order; eviction keeps the newest writes", async () => {
    const calls = [look("a"), look("b"), look("c"), look("d")]
    const r = rig(calls, { bodyBytes: 64, maxBlobs: 2 })
    const done = runToolCalls(r.host, calls, undefined)
    await flush()
    for (const id of ["d", "c", "b", "a"]) {
      r.release(id)
      await flush()
    }
    await done
    // The blob write is in the post-run section: one at a time, in end
    // order. A running call has no blob yet, so each eviction sees all
    // earlier writes, as in a serial batch run in end order.
    expect(r.blobWrites).toEqual(["d", "c", "b", "a"])
    expect(r.blobPeak.value).toBe(1)
    // The cap keeps the 2 newest blobs: d and c are evicted, b and a (the
    // last writes) stay.
    expect(readdirSync(r.blobDir).sort()).toEqual(["a.raw", "b.raw"])
    // Each saved record cites its own blob id (per-id names).
    expect(savedIds(r)).toEqual(["a", "b", "c", "d"])
  })

  test("abort before a queued call starts: the real round gives the aborted result", async () => {
    const calls = [look("a"), look("b"), look("c")]
    const r = rig(calls, { cap: 2 })
    const ac = new AbortController()
    const done = runToolCalls(r.host, calls, ac.signal)
    await flush()
    expect(r.starts).toEqual(["a", "b"])
    ac.abort()
    const results = await done
    expect(r.starts).toEqual(["a", "b"])
    expect(results.map((x) => x.tool_use_id)).toEqual(["a", "b", "c"])
    expect(results[2]).toMatchObject({ content: "tool aborted by user", is_error: true })
    // c has no `started` view event: it never ran.
    expect(r.view).not.toContain("started:c")
    expect(resultIds(r.events)).toEqual(["a", "b", "c"])
  })

  test("a deny by tool.willInvoke inside a wave: the others go on", async () => {
    const calls = [look("a"), look("b"), look("c")]
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(payload) {
        if (payload.toolUseId === "b") return { action: "deny" as const, reason: "no b" }
        return { action: "allow" as const, payload }
      },
    }
    const r = rig(calls, { lifecycle })
    r.releaseAll()
    const results = await runToolCalls(r.host, calls, undefined)
    expect(r.starts).toEqual(["a", "c"])
    expect(results[1]?.is_error).toBe(true)
    expect(results[0]?.is_error).toBe(false)
    expect(results[2]?.is_error).toBe(false)
    expect(savedIds(r)).toEqual(["a", "b", "c"])
  })

  test("two admissions that ask a human (failClosed hook): one at a time, in call order", async () => {
    const calls = [look("a"), look("b")]
    const prompts: string[] = []
    const answers = new Map<string, () => void>()
    let open = 0
    let peak = 0
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      hasFailClosedToolHook: () => true,
      async beforeTool(payload) {
        prompts.push(payload.toolUseId)
        open++
        peak = Math.max(peak, open)
        await new Promise<void>((res) => answers.set(payload.toolUseId, res))
        open--
        return { action: "allow" as const, payload }
      },
    }
    const r = rig(calls, { lifecycle })
    r.releaseAll()
    const done = runToolCalls(r.host, calls, undefined)
    await flush()
    expect(prompts).toEqual(["a"])
    // b is announced only after a is admitted (announce before ask).
    expect(r.events.filter((e) => e.type === "tool_call").length).toBe(1)
    answers.get("a")?.()
    await flush()
    expect(prompts).toEqual(["a", "b"])
    answers.get("b")?.()
    await done
    expect(peak).toBe(1)
  })

  test("a throw in the session store: running calls get the abort, saved results are a prefix", async () => {
    const calls = [look("a"), look("b"), look("c"), look("d")]
    const r = rig(calls, { failSaveOf: "b" })
    const done = runToolCalls(r.host, calls, undefined)
    const failed = done.then(
      () => null,
      (error: unknown) => error,
    )
    await flush()
    r.release("a")
    r.release("b")
    expect(String(await failed)).toContain("disk full")
    expect(savedIds(r)).toEqual(["a"])
    expect(resultIds(r.events)).toEqual(["a"])
  })

  test("crash after result 2 of 4: the saved results are a prefix and restore is clean", async () => {
    const calls = [look("t1"), look("t2"), look("t3"), look("t4")]
    const r = rig(calls, { failSaveOf: "t3" })
    const done = runToolCalls(r.host, calls, undefined)
    const failed = done.then(
      () => null,
      (error: unknown) => error,
    )
    await flush()
    // t4 and t3 end first; t1 and t2 end later.
    for (const id of ["t4", "t3", "t2", "t1"]) {
      r.release(id)
      await flush()
    }
    expect(String(await failed)).toContain("disk full")
    expect(savedIds(r)).toEqual(["t1", "t2"])
    // Restore (the `--resume` path): the run has a round checkpoint, the
    // history keeps all 4 tool_use blocks and the 2 saved results, and the
    // repair adds a result only for the cut-off calls t3 and t4.
    const loaded = loadSession(r.sid, r.dir)
    expect(lastTurnRoundCheckpoint(loaded.records)?.round).toBe(1)
    const messages = loaded.messages
    const last = messages.at(-1)
    expect(last?.role).toBe("user")
    const kept = Array.isArray(last?.content)
      ? last.content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []))
      : []
    expect(kept).toEqual(["t1", "t2"])
    const added = closeInterruptedToolCalls(messages)
    expect(added.map((b) => b.tool_use_id)).toEqual(["t3", "t4"])
    const repaired = messages.at(-1)
    const ids = Array.isArray(repaired?.content)
      ? repaired.content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []))
      : []
    expect(ids).toEqual(["t1", "t2", "t3", "t4"])
  })

  test("per-input export false makes a serial call in the real round", async () => {
    const calls = [look("a"), look("b", { serial: true }), look("c")]
    const r = rig(calls)
    const policy = (r.host.executor as ToolExecutorAdapter).concurrency
    expect(policy.isCallConcurrencySafe("Look", { serial: true })).toBe(false)
    const done = runToolCalls(r.host, calls, undefined)
    await flush()
    expect(r.starts).toEqual(["a"])
    r.release("a")
    await flush()
    expect(r.starts).toEqual(["a", "b"])
    r.release("b")
    await flush()
    expect(r.starts).toEqual(["a", "b", "c"])
    r.release("c")
    await done
    expect(savedIds(r)).toEqual(["a", "b", "c"])
  })
})

/** A failClosed tool.willInvoke listener that counts the calls it sees. */
function countingApproval(answerAtOnce: boolean): {
  lifecycle: LifecyclePort
  asked: string[]
  didInvoke: string[]
  answer(id: string): void
} {
  const asked: string[] = []
  const didInvoke: string[] = []
  const answers = new Map<string, () => void>()
  const lifecycle: LifecyclePort = {
    ...NOOP_LIFECYCLE,
    hasFailClosedToolHook: () => true,
    async beforeTool(payload) {
      asked.push(payload.toolUseId)
      if (!answerAtOnce) await new Promise<void>((res) => answers.set(payload.toolUseId, res))
      return { action: "allow" as const, payload }
    },
    async afterTool(payload) {
      didInvoke.push(payload.tool)
      return payload
    },
  }
  return { lifecycle, asked, didInvoke, answer: (id) => answers.get(id)?.() }
}

describe("wave hooks: tool.willInvoke only for a call that can start (BUG 9)", () => {
  test("cap 2, 4 safe calls: abort while calls 3-4 wait for a slot gives 2 willInvoke, not 4", async () => {
    const calls = [look("a"), look("b"), look("c"), look("d")]
    const approval = countingApproval(true)
    const r = rig(calls, { cap: 2, lifecycle: approval.lifecycle })
    const ac = new AbortController()
    const done = runToolCalls(r.host, calls, ac.signal)
    await flush()
    expect(r.starts).toEqual(["a", "b"])
    // c waits for a slot BEFORE its admission: no tool.willInvoke for it.
    expect(approval.asked).toEqual(["a", "b"])
    ac.abort()
    const results = await done
    expect(approval.asked).toEqual(["a", "b"])
    expect(r.starts).toEqual(["a", "b"])
    expect(results.map((x) => x.tool_use_id)).toEqual(["a", "b", "c", "d"])
    expect(results[2]).toMatchObject({ content: "tool aborted by user", is_error: true })
    expect(results[3]).toMatchObject({ content: "tool aborted by user", is_error: true })
    // No call that never started got tool.didInvoke.
    expect(approval.didInvoke.length).toBeLessThanOrEqual(2)
  })

  test("admission of call k+1 starts only after call k has its slot; a slow approval holds one slot", async () => {
    const calls = [look("a"), look("b"), look("c"), look("d")]
    const approval = countingApproval(false)
    const held = rig(calls, { cap: 2, lifecycle: approval.lifecycle })
    const release = held.release
    const done = runToolCalls(held.host, calls, undefined)
    await flush()
    expect(approval.asked).toEqual(["a"])
    approval.answer("a")
    await flush()
    expect(held.starts).toEqual(["a"])
    // b is in admission: it holds the second slot while the human answers.
    expect(approval.asked).toEqual(["a", "b"])
    approval.answer("b")
    await flush()
    expect(held.starts).toEqual(["a", "b"])
    // No slot is free: c is announced but not asked, d is not announced.
    expect(approval.asked).toEqual(["a", "b"])
    expect(held.events.filter((e) => e.type === "tool_call").length).toBe(3)
    release("a")
    await flush()
    // a ended: c gets the slot, then its admission starts.
    expect(approval.asked).toEqual(["a", "b", "c"])
    approval.answer("c")
    await flush()
    expect(held.starts).toEqual(["a", "b", "c"])
    expect(approval.asked).toEqual(["a", "b", "c"])
    release("b")
    await flush()
    approval.answer("d")
    await flush()
    release("c")
    release("d")
    await done
    expect(approval.asked).toEqual(["a", "b", "c", "d"])
    expect(savedIds(held)).toEqual(["a", "b", "c", "d"])
  })

  test("abort while a human approval is pending for b and c-d wait: after the answer, c and d end aborted with no tool.willInvoke (no deadlock)", async () => {
    const calls = [look("a"), look("b"), look("c"), look("d")]
    const approval = countingApproval(false)
    const r = rig(calls, { cap: 2, lifecycle: approval.lifecycle })
    const ac = new AbortController()
    const done = runToolCalls(r.host, calls, ac.signal)
    await flush()
    approval.answer("a")
    await flush()
    // a runs with slot 1; b is in admission with slot 2; c and d wait.
    expect(r.starts).toEqual(["a"])
    expect(approval.asked).toEqual(["a", "b"])
    ac.abort()
    await flush()
    // The approval has no abort signal: c and d still wait for it.
    expect(approval.asked).toEqual(["a", "b"])
    approval.answer("b")
    const results = await done
    expect(approval.asked).toEqual(["a", "b"])
    expect(r.starts).toEqual(["a"])
    expect(results.map((x) => x.tool_use_id)).toEqual(["a", "b", "c", "d"])
    expect(results[2]).toMatchObject({ content: "tool aborted by user", is_error: true })
    expect(results[3]).toMatchObject({ content: "tool aborted by user", is_error: true })
    expect(approval.didInvoke).not.toContain("c")
    expect(approval.didInvoke).not.toContain("d")
  })

  test("a call that the per-input check makes serial gives its slot back (X2)", async () => {
    const calls = [look("a"), look("b", { serial: true }), look("c")]
    const approval = countingApproval(true)
    const r = rig(calls, { cap: 2, lifecycle: approval.lifecycle })
    const done = runToolCalls(r.host, calls, undefined)
    await flush()
    // b passed tool.willInvoke and waits for a (X2): it holds no slot.
    expect(approval.asked).toEqual(["a", "b"])
    expect(r.starts).toEqual(["a"])
    r.release("a")
    await flush()
    expect(r.starts).toEqual(["a", "b"])
    r.release("b")
    await flush()
    expect(r.starts).toEqual(["a", "b", "c"])
    r.release("c")
    await done
    expect(savedIds(r)).toEqual(["a", "b", "c"])
  })
})

describe("serial path: user abort after tool.willInvoke", () => {
  test("a built-in call ends with the aborted result and no tool.didInvoke", async () => {
    const calls: ToolUseBlock[] = [
      { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/dev/null" } },
    ]
    const ac = new AbortController()
    const approval = countingApproval(true)
    const lifecycle: LifecyclePort = {
      ...approval.lifecycle,
      async beforeTool(payload) {
        approval.asked.push(payload.toolUseId)
        // The user aborts while the call is in tool.willInvoke.
        ac.abort()
        return { action: "allow" as const, payload }
      },
    }
    const r = rig(calls, { cap: 1, lifecycle })
    const results = await runToolCalls(r.host, calls, ac.signal)
    expect(approval.asked).toEqual(["r1"])
    expect(approval.didInvoke).toEqual([])
    // The aborted outcome ("canceled" in a bare core with no text resolver).
    expect(results[0]?.is_error).toBe(true)
    expect(String(results[0]?.content)).toBe("canceled")
    expect(r.view).toContain("outcome:r1")
  })
})

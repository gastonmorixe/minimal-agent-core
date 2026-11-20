/**
 * The order rules of a wave with the real tool round (`executeToolRound`)
 * and built-in tools through the `executeTool` test seam (decision 3', SPEC
 * D4, X2, X3, X5). Admission and the save go in call order; the post-run
 * steps (result chain, `tool.didInvoke`, the `outcome` view event) go one
 * call at a time in end order. Each run ends when the test opens its gate.
 *
 * @module sdk/tool-call-waves.order.test
 */

import { describe, expect, test } from "bun:test"

import type { ToolViewEvent } from "../agent/tool-view-port.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { executeToolRound, type ToolRoundContext } from "../loops/tool-round.ts"
import type { ModeManager } from "../modes/modes.ts"
import type { SessionStore } from "../session/session-store.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import type { AgentEvent } from "./events.ts"
import { type LifecyclePort, NOOP_LIFECYCLE } from "./lifecycle.ts"
import type { ToolConcurrencyPolicy, ToolExecutor } from "./ports.ts"
import { runToolCalls, type ToolCallHost } from "./tool-calls.ts"

/** Let all queued jobs run. */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((res) => setTimeout(res, 0))
}

/** A `Read` call whose run is keyed by `id` (its `file_path`). */
function read(id: string): ToolUseBlock {
  return { type: "tool_use", id, name: "Read", input: { file_path: id } }
}

/** A `Grep` call whose run is keyed by `id` (its `pattern`). */
function grep(id: string): ToolUseBlock {
  return { type: "tool_use", id, name: "Grep", input: { pattern: id } }
}

/** A tool with no built-in spec and no flag: a serial call. */
function custom(id: string): ToolUseBlock {
  return { type: "tool_use", id, name: "Custom", input: { file_path: id } }
}

const SAFE = new Set(["Read", "Grep"])

/** `Read`/`Grep` have the flag. A `file_path` that starts with "serial" fails the per-input check. */
const POLICY: ToolConcurrencyPolicy = {
  toolFlag: (name) => ({ flag: SAFE.has(name) }),
  isCallConcurrencySafe: (name, input) =>
    SAFE.has(name) && !String(input.file_path ?? "").startsWith("serial"),
}

interface Rig {
  host: ToolCallHost
  events: AgentEvent[]
  /** Saved tool results, in save order. */
  saved: string[]
  /** Run starts (the `executeTool` seam), in order. */
  starts: string[]
  /** View events as `type:id`. */
  view: string[]
  /** The `started` view events. */
  started: Extract<ToolViewEvent, { type: "started" }>[]
  /** The `outcome` view events. */
  outcomes: Extract<ToolViewEvent, { type: "outcome" }>[]
  /** Tool names that the feedback tracker observed, in order. */
  observed: string[]
  clock: { t: number }
  release(id: string): void
  releaseAll(): void
}

interface RigOptions {
  cap?: number
  lifecycle?: LifecyclePort
  /** Mode gate: refuse the calls with these ids. */
  modeRefuses?: readonly string[]
}

function rig(opts: RigOptions = {}): Rig {
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
  const events: AgentEvent[] = []
  const saved: string[] = []
  const starts: string[] = []
  const view: string[] = []
  const started: Extract<ToolViewEvent, { type: "started" }>[] = []
  const outcomes: Extract<ToolViewEvent, { type: "outcome" }>[] = []
  const observed: string[] = []
  const tracker = new ToolFeedbackTracker()
  const observe = tracker.observe.bind(tracker)
  tracker.observe = (tool, truncated, text) => {
    observed.push(tool)
    return observe(tool, truncated, text)
  }
  const refuses = new Set(opts.modeRefuses ?? [])
  const modeManager = {
    isToolAllowed: (_name: string, input: Record<string, unknown>) =>
      refuses.has(String(input.file_path))
        ? { allowed: false as const, message: "refused by mode" }
        : { allowed: true as const },
    activeId: () => "plan",
    activeStampFacts: () => null,
  } as unknown as ModeManager
  const executeTool = (async (
    _name: string,
    input: Record<string, unknown>,
    o?: { signal?: AbortSignal },
  ) => {
    const id = String(input.file_path ?? input.pattern)
    starts.push(id)
    await Promise.race([
      gateOf(id).promise,
      new Promise<void>((res) => o?.signal?.addEventListener("abort", () => res())),
    ])
    return { content: o?.signal?.aborted ? `aborted ${id}` : `out ${id}`, is_error: false }
  }) as unknown as NonNullable<ToolRoundContext["executeTool"]>
  const store = {
    appendToolResult: (block: { tool_use_id: string }) => saved.push(block.tool_use_id),
  } as unknown as SessionStore
  const executor: ToolExecutor = {
    concurrency: POLICY,
    async execute(tool, signal, context) {
      const block = await executeToolRound(tool, {
        toolView: {
          onToolEvent(e: ToolViewEvent) {
            if (e.type === "started") started.push(e)
            if (e.type === "outcome") outcomes.push(e)
            if (e.type !== "output") view.push(`${e.type}:${e.tool.id}`)
          },
        },
        loader: null,
        modeManager,
        blobStore: null,
        blobSkipTools: new Set(),
        feedbackTracker: tracker,
        model: "test-model",
        store,
        lifecycle: opts.lifecycle ?? NOOP_LIFECYCLE,
        executeTool,
        ...(signal ? { signal } : {}),
        ...(context?.gates ? { gates: context.gates } : {}),
        ...(context?.concurrent === true ? { concurrent: true } : {}),
      })
      return { content: block.content, isError: block.is_error === true }
    },
  }
  const clock = { t: 0 }
  const host: ToolCallHost = {
    executor,
    persistence: null,
    emit: (e) => events.push(e),
    wantsToolOutput: true,
    now: () => clock.t,
    maxConcurrentToolCalls: opts.cap ?? 10,
  }
  return {
    host,
    events,
    saved,
    starts,
    view,
    started,
    outcomes,
    observed,
    clock,
    release: (id) => gateOf(id).open(),
    releaseAll: () => {
      all = true
      for (const g of gates.values()) g.open()
    },
  }
}

function sdkLog(events: AgentEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === "tool_output"
      ? [`output:${e.callId}`]
      : e.type === "tool_result"
        ? [`result:${e.id}`]
        : [],
  )
}

describe("wave order with the real tool round (decision 3')", () => {
  test("call 2 ends first: its outcome comes first; saves and SDK events stay in call order", async () => {
    const r = rig()
    const done = runToolCalls(r.host, [read("a"), read("b")], undefined)
    await flush()
    expect(r.starts).toEqual(["a", "b"])
    r.release("b")
    await flush()
    // b is complete for the host, but nothing is saved before a.
    expect(r.view.filter((v) => v.startsWith("outcome"))).toEqual(["outcome:b"])
    expect(r.saved).toEqual([])
    expect(sdkLog(r.events)).toEqual([])
    r.release("a")
    const results = await done
    expect(r.view.filter((v) => v.startsWith("outcome"))).toEqual(["outcome:b", "outcome:a"])
    expect(r.saved).toEqual(["a", "b"])
    expect(sdkLog(r.events)).toEqual(["output:a", "result:a", "output:b", "result:b"])
    expect(results.map((x) => x.tool_use_id)).toEqual(["a", "b"])
  })

  test("tool.didInvoke never overlaps; it runs in end order, keyed by toolUseId", async () => {
    let open = 0
    let peak = 0
    const order: string[] = []
    const answers = new Map<string, () => void>()
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async afterTool(payload) {
        const id = String(payload.input.file_path)
        order.push(id)
        open++
        peak = Math.max(peak, open)
        await new Promise<void>((res) => answers.set(id, res))
        open--
        return payload
      },
    }
    const r = rig({ lifecycle })
    const done = runToolCalls(r.host, [read("a"), read("b"), read("c")], undefined)
    await flush()
    r.release("c")
    r.release("a")
    r.release("b")
    await flush()
    // c ended first and holds the section; a and b wait.
    expect(order).toEqual(["c"])
    answers.get("c")?.()
    await flush()
    expect(order).toEqual(["c", "a"])
    answers.get("a")?.()
    await flush()
    answers.get("b")?.()
    await done
    expect(order).toEqual(["c", "a", "b"])
    expect(peak).toBe(1)
    expect(r.saved).toEqual(["a", "b", "c"])
  })

  test("abort while a call waits for the post-run section: it leaves the queue, the holder goes on", async () => {
    const answers = new Map<string, () => void>()
    const didInvoke: string[] = []
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async afterTool(payload) {
        const id = String(payload.input.file_path)
        didInvoke.push(id)
        await new Promise<void>((res) => answers.set(id, res))
        return payload
      },
    }
    const r = rig({ lifecycle })
    const ac = new AbortController()
    const done = runToolCalls(r.host, [read("a"), read("b")], ac.signal)
    await flush()
    r.release("a")
    await flush()
    r.release("b")
    await flush()
    // a holds the section (in tool.didInvoke); b waits for it.
    expect(didInvoke).toEqual(["a"])
    ac.abort()
    await flush()
    answers.get("a")?.()
    const results = await done
    // b never entered: no didInvoke, the aborted result. a keeps its result.
    expect(didInvoke).toEqual(["a"])
    expect(results[0]).toMatchObject({ content: expect.stringContaining("out a") })
    expect(results[1]).toMatchObject({ content: "tool aborted by user", is_error: true })
    expect(r.saved).toEqual(["a"])
    expect(sdkLog(r.events)).toEqual(["output:a", "result:a", "result:b"])
    // MINOR-3: b still gets a view outcome that marks it aborted.
    const outcomeB = r.outcomes.find((e) => e.tool.id === "b")
    expect(outcomeB?.outcome).toMatchObject({ aborted: true, isError: true, findings: [] })
    expect(outcomeB?.outcome.content).not.toBe("")
    expect(r.outcomes.find((e) => e.tool.id === "a")?.outcome.aborted).toBe(false)
  })

  test("started.concurrent: true for calls of a wave of 2 or more", async () => {
    const r = rig()
    r.releaseAll()
    await runToolCalls(r.host, [read("a"), grep("b")], undefined)
    expect(r.started.map((e) => [e.tool.id, e.concurrent])).toEqual([
      ["a", true],
      ["b", true],
    ])
  })

  test("started.concurrent: key absent at cap 1", async () => {
    const r = rig({ cap: 1 })
    r.releaseAll()
    await runToolCalls(r.host, [read("a"), read("b")], undefined)
    expect(r.started.length).toBe(2)
    for (const e of r.started) expect("concurrent" in e).toBe(false)
  })

  test("started.concurrent: key absent for a one-call wave (a flagged call alone)", async () => {
    const r = rig()
    r.releaseAll()
    await runToolCalls(r.host, [custom("x"), read("a"), custom("y"), read("b")], undefined)
    expect(r.started.map((e) => e.tool.id)).toEqual(["x", "a", "y", "b"])
    for (const e of r.started) expect("concurrent" in e).toBe(false)
  })

  test("started.concurrent: key absent for a call that the per-input check makes serial", async () => {
    const r = rig()
    r.releaseAll()
    await runToolCalls(r.host, [read("a"), read("serial-b"), read("c")], undefined)
    const byId = new Map(r.started.map((e) => [e.tool.id, e]))
    expect(byId.get("a")?.concurrent).toBe(true)
    expect("concurrent" in (byId.get("serial-b") ?? {})).toBe(false)
    expect(byId.get("c")?.concurrent).toBe(true)
  })

  test("a mode-gate refusal and an input error inside a wave: the others go on", async () => {
    const r = rig({ modeRefuses: ["b"] })
    const noPath: ToolUseBlock = { type: "tool_use", id: "c", name: "Read", input: {} }
    const done = runToolCalls(r.host, [read("a"), read("b"), noPath, read("d")], undefined)
    await flush()
    expect(r.starts).toEqual(["a", "d"])
    r.release("d")
    await flush()
    r.release("a")
    const results = await done
    expect(results.map((x) => x.is_error === true)).toEqual([false, true, true, false])
    expect(r.view).toContain("refused:b")
    expect(r.view).toContain("input_error:c")
    expect(r.saved).toEqual(["a", "b", "c", "d"])
    expect(sdkLog(r.events).filter((e) => e.startsWith("result"))).toEqual([
      "result:a",
      "result:b",
      "result:c",
      "result:d",
    ])
  })

  test("X5: the feedback tracker observes the calls one at a time in end order", async () => {
    const r = rig()
    const done = runToolCalls(r.host, [read("a"), grep("b")], undefined)
    await flush()
    r.release("b")
    await flush()
    r.release("a")
    await done
    expect(r.observed).toEqual(["Grep", "Read"])
  })

  test("durationMs is the admission time and the run time, not the slot or delivery wait", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(payload) {
        // The admission of a takes 3 ms (t=0 to t=3).
        if (payload.toolUseId === "a") r.clock.t += 3
        return { action: "allow" as const, payload }
      },
    }
    const r = rig({ cap: 2, lifecycle })
    const done = runToolCalls(r.host, [read("a"), read("b"), read("c")], undefined)
    await flush()
    expect(r.starts).toEqual(["a", "b"])
    // a runs from t=3 to t=50 (admission 3 + run 47). b runs from t=3 to
    // t=10; c waits for a slot from t=3 to t=10.
    r.clock.t = 10
    r.release("b")
    await flush()
    expect(r.starts).toEqual(["a", "b", "c"])
    r.clock.t = 15
    r.release("c")
    await flush()
    // b and c wait for the delivery of a until t=50.
    r.clock.t = 50
    r.release("a")
    await done
    const durations = r.events.flatMap((e) =>
      e.type === "tool_result" ? [`${e.id}=${e.durationMs}`] : [],
    )
    expect(durations).toEqual(["a=50", "b=7", "c=5"])
  })
})

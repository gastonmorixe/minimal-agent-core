/**
 * The wave scheduler of `runToolCalls` (SPEC D2-D5, D9, X1-X3, section 7)
 * with a fake executor that calls the gates the same way the tool round
 * does: admission, `admitted(input)`, the run, `ran()`, then the in-order
 * steps. No timers: each run ends when the test resolves it.
 *
 * @module sdk/tool-call-waves.test
 */

import { describe, expect, test } from "bun:test"

import type { ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"

import type { AgentEvent } from "./events.ts"
import type {
  ToolCallGates,
  ToolConcurrencyPolicy,
  ToolExecContext,
  ToolExecutor,
} from "./ports.ts"
import { runToolCalls, type ToolCallHost } from "./tool-calls.ts"

/** Tools named `S*` have the tool flag. All other names are serial. */
const POLICY: ToolConcurrencyPolicy = {
  toolFlag: (name) => ({ flag: name.startsWith("S") }),
  isCallConcurrencySafe: (name, input) => name.startsWith("S") && input.serial !== true,
}

function call(id: string, name = "Safe", input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: "tool_use", id, name, input }
}

/** A promise that the test resolves. */
function gate(): { promise: Promise<void>; open(): void } {
  let open = () => {}
  const promise = new Promise<void>((res) => {
    open = res
  })
  return { promise, open }
}

/** Let all queued jobs run (promise jobs and the lazy module load). */
async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((res) => setTimeout(res, 0))
}

interface Harness {
  host: ToolCallHost
  /** SDK events in emit order. */
  events: AgentEvent[]
  /** Saved results in save order. */
  saved: string[]
  /** Live port events (`start:<id>` / `end:<id>`), in the order they fire. */
  ports: string[]
  /** Admission log (`admit:<id>`). */
  admissions: string[]
  /** Ids that run now. */
  running: Set<string>
  /** The largest number of runs at the same time. */
  peak: { value: number }
  /** Release the run of `id`. */
  release(id: string): void
  /** Release all runs, now and later. */
  releaseAll(): void
  /** The signals that the runs got. */
  signals: Map<string, AbortSignal>
  clock: { t: number }
}

interface HarnessOptions {
  cap?: number
  /** Admission of a call: return false to refuse it (a deny). */
  admit?: (tool: ToolUseBlock) => Promise<boolean> | boolean
  /** Save hook: throw to fail the loop. */
  onSave?: (id: string) => void
  /** The run of a call throws (the executor rejects). */
  throwOn?: string
}

function harness(opts: HarnessOptions = {}): Harness {
  const events: AgentEvent[] = []
  const saved: string[] = []
  const ports: string[] = []
  const admissions: string[] = []
  const running = new Set<string>()
  const peak = { value: 0 }
  const gates = new Map<string, ReturnType<typeof gate>>()
  const signals = new Map<string, AbortSignal>()
  let all = false
  const clock = { t: 0 }
  const runGate = (id: string) => {
    let g = gates.get(id)
    if (!g) {
      g = gate()
      gates.set(id, g)
      if (all) g.open()
    }
    return g
  }
  const executor: ToolExecutor = {
    concurrency: POLICY,
    async execute(tool: ToolUseBlock, signal?: AbortSignal, ctx?: ToolExecContext) {
      admissions.push(`admit:${tool.id}`)
      const allowed = opts.admit ? await opts.admit(tool) : true
      if (!allowed) {
        await ctx?.gates?.admitted(null)
        await ctx?.gates?.ran()
        return { content: `denied ${tool.id}`, isError: true }
      }
      await ctx?.gates?.admitted(tool.input as Record<string, unknown>)
      if (signal) signals.set(tool.id, signal)
      running.add(tool.id)
      peak.value = Math.max(peak.value, running.size)
      ports.push(`start:${tool.id}`)
      try {
        await Promise.race([
          runGate(tool.id).promise,
          new Promise<void>((res) => signal?.addEventListener("abort", () => res())),
        ])
        if (opts.throwOn === tool.id) throw new Error(`boom ${tool.id}`)
      } finally {
        running.delete(tool.id)
        ports.push(`end:${tool.id}`)
      }
      await ctx?.gates?.ran()
      return {
        content: signal?.aborted ? `aborted ${tool.id}` : `ok ${tool.id}`,
        isError: false,
      }
    },
  }
  const host: ToolCallHost = {
    executor,
    persistence: {
      appendToolResult: (r: ToolResultBlock) => {
        opts.onSave?.(r.tool_use_id)
        saved.push(r.tool_use_id)
      },
    } as never,
    emit: (e) => events.push(e),
    wantsToolOutput: true,
    now: () => clock.t,
    maxConcurrentToolCalls: opts.cap ?? 10,
  }
  return {
    host,
    events,
    saved,
    ports,
    admissions,
    running,
    peak,
    release: (id) => runGate(id).open(),
    releaseAll: () => {
      all = true
      for (const g of gates.values()) g.open()
    },
    signals,
    clock,
  }
}

/** The SDK event log as short strings. */
function eventLog(events: AgentEvent[]): string[] {
  return events.map((e) => {
    switch (e.type) {
      case "tool_call":
        return `call:${e.callId}`
      case "status":
        return `status:${e.toolName}`
      case "tool_output":
        return `output:${e.callId}`
      case "tool_result":
        return `result:${e.id}`
      default:
        return e.type
    }
  })
}

describe("runToolCalls / wave scheduler", () => {
  test("cap 1 takes the serial path: no gates, same events as before", async () => {
    const h = harness({ cap: 1 })
    let gated = 0
    const inner = h.host.executor
    h.host.executor = {
      concurrency: POLICY,
      execute: async (tool, signal, ctx) => {
        if (ctx?.gates) gated++
        h.releaseAll()
        return inner.execute(tool, signal, ctx)
      },
    }
    const results = await runToolCalls(h.host, [call("a"), call("b")], undefined)
    expect(gated).toBe(0)
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "b"])
    expect(eventLog(h.events)).toEqual([
      "call:a",
      "status:Safe",
      "output:a",
      "result:a",
      "call:b",
      "status:Safe",
      "output:b",
      "result:b",
    ])
  })

  test("no two consecutive safe calls takes the serial path", async () => {
    const h = harness()
    let gated = 0
    const inner = h.host.executor
    h.host.executor = {
      concurrency: POLICY,
      execute: async (tool, signal, ctx) => {
        if (ctx?.gates) gated++
        h.releaseAll()
        return inner.execute(tool, signal, ctx)
      },
    }
    await runToolCalls(h.host, [call("a"), call("b", "Edit"), call("c")], undefined)
    expect(gated).toBe(0)
  })

  test("a wave where call 1 ends last: events and records in call order, ports in end order", async () => {
    const h = harness()
    const done = runToolCalls(h.host, [call("a"), call("b"), call("c")], undefined)
    await flush()
    expect([...h.running].sort()).toEqual(["a", "b", "c"])
    h.release("c")
    await flush()
    h.release("b")
    await flush()
    // Calls b and c ended, but a did not: nothing is delivered yet.
    expect(h.saved).toEqual([])
    expect(eventLog(h.events).filter((e) => e.startsWith("result"))).toEqual([])
    h.release("a")
    const results = await done
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "b", "c"])
    expect(results.map((r) => r.content)).toEqual(["ok a", "ok b", "ok c"])
    expect(h.saved).toEqual(["a", "b", "c"])
    expect(h.ports).toEqual(["start:a", "start:b", "start:c", "end:c", "end:b", "end:a"])
    expect(eventLog(h.events)).toEqual([
      "call:a",
      "status:Safe",
      "call:b",
      "status:Safe",
      "call:c",
      "status:Safe",
      "output:a",
      "result:a",
      "output:b",
      "result:b",
      "output:c",
      "result:c",
    ])
  })

  test("mixed batch A,B safe, C serial, D,E safe: C after A and B, D after C", async () => {
    const h = harness()
    h.releaseAll()
    const results = await runToolCalls(
      h.host,
      [call("A"), call("B"), call("C", "Edit"), call("D"), call("E")],
      undefined,
    )
    expect(results.map((r) => r.tool_use_id)).toEqual(["A", "B", "C", "D", "E"])
    const at = (s: string) => h.ports.indexOf(s)
    expect(at("start:C")).toBeGreaterThan(at("end:A"))
    expect(at("start:C")).toBeGreaterThan(at("end:B"))
    expect(at("start:D")).toBeGreaterThan(at("end:C"))
    // C is announced only after A and B are delivered.
    const log = eventLog(h.events)
    expect(log.indexOf("call:C")).toBeGreaterThan(log.indexOf("result:B"))
    expect(log.indexOf("call:D")).toBeGreaterThan(log.indexOf("result:C"))
    expect(h.saved).toEqual(["A", "B", "C", "D", "E"])
  })

  test("12 safe calls with cap 10: 10 start first, the rest start in call order", async () => {
    const h = harness({ cap: 10 })
    const ids = Array.from({ length: 12 }, (_, i) => `c${i + 1}`)
    const done = runToolCalls(
      h.host,
      ids.map((id) => call(id)),
      undefined,
    )
    await flush()
    expect(h.running.size).toBe(10)
    expect(h.ports).toEqual(ids.slice(0, 10).map((id) => `start:${id}`))
    // All 12 are admitted and announced in call order.
    expect(h.admissions).toEqual(ids.map((id) => `admit:${id}`))
    h.release("c5")
    await flush()
    expect(h.ports.at(-1)).toBe("start:c11")
    h.release("c2")
    await flush()
    expect(h.ports.at(-1)).toBe("start:c12")
    h.releaseAll()
    const results = await done
    expect(h.peak.value).toBe(10)
    expect(results.map((r) => r.tool_use_id)).toEqual(ids)
    expect(h.saved).toEqual(ids)
  })

  test("abort inside a wave: running calls get the signal, finished calls keep results", async () => {
    const ac = new AbortController()
    const h = harness({ cap: 2 })
    const done = runToolCalls(h.host, [call("a"), call("b"), call("c")], ac.signal)
    await flush()
    h.release("a")
    await flush()
    // a is delivered, b and c run.
    expect(h.saved).toEqual(["a"])
    ac.abort()
    const results = await done
    expect(h.signals.get("b")?.aborted).toBe(true)
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "b", "c"])
    expect(results[0]?.content).toBe("ok a")
    expect(results[1]?.content).toBe("aborted b")
    expect(h.saved).toEqual(["a", "b", "c"])
  })

  test("abort before a queued call starts: it gets the aborted result and never runs", async () => {
    const ac = new AbortController()
    const h = harness({ cap: 2 })
    const done = runToolCalls(h.host, [call("a"), call("b"), call("c"), call("d")], ac.signal)
    await flush()
    expect([...h.running].sort()).toEqual(["a", "b"])
    // c waits for a slot. The abort comes, then a slot opens.
    ac.abort()
    const results = await done
    expect(h.ports.filter((p) => p.startsWith("start"))).toEqual(["start:a", "start:b"])
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "b", "c", "d"])
    expect(results[2]).toMatchObject({ content: "tool aborted by user", is_error: true })
    expect(results[3]).toMatchObject({ content: "tool aborted by user", is_error: true })
    expect(h.saved).toEqual(["a", "b", "c", "d"])
  })

  test("a call denied at admission inside a wave: the others go on", async () => {
    const h = harness({ admit: (t) => t.id !== "b" })
    h.releaseAll()
    const results = await runToolCalls(h.host, [call("a"), call("b"), call("c")], undefined)
    expect(results.map((r) => r.content)).toEqual(["ok a", "denied b", "ok c"])
    expect(results[1]?.is_error).toBe(true)
    expect(h.ports).not.toContain("start:b")
    expect(h.saved).toEqual(["a", "b", "c"])
  })

  test("two admissions that ask a human come one at a time, in call order", async () => {
    const prompts: string[] = []
    const answers = new Map<string, () => void>()
    let open = 0
    let peakOpen = 0
    const h = harness({
      admit: async (t) => {
        prompts.push(t.id)
        open++
        peakOpen = Math.max(peakOpen, open)
        await new Promise<void>((res) => answers.set(t.id, res))
        open--
        return true
      },
    })
    h.releaseAll()
    const done = runToolCalls(h.host, [call("a"), call("b")], undefined)
    await flush()
    expect(prompts).toEqual(["a"])
    // b is not announced before a is admitted.
    expect(eventLog(h.events)).toEqual(["call:a", "status:Safe"])
    answers.get("a")?.()
    await flush()
    expect(prompts).toEqual(["a", "b"])
    expect(eventLog(h.events).slice(2, 4)).toEqual(["call:b", "status:Safe"])
    answers.get("b")?.()
    await done
    expect(peakOpen).toBe(1)
  })

  test("a throw in persistence: running calls get the abort, saved results are a prefix", async () => {
    const h = harness({
      onSave: (id) => {
        if (id === "b") throw new Error("disk full")
      },
    })
    const done = runToolCalls(h.host, [call("a"), call("b"), call("c"), call("d")], undefined)
    // Read the rejection with a handler: an `expect(...).rejects` before the
    // release would wait for the promise and block the test.
    const failed = done.then(
      () => null,
      (error: unknown) => error,
    )
    await flush()
    h.release("a")
    h.release("b")
    expect(String(await failed)).toContain("disk full")
    expect(h.saved).toEqual(["a"])
    expect(h.signals.get("c")?.aborted).toBe(true)
    expect(h.signals.get("d")?.aborted).toBe(true)
    expect(h.running.size).toBe(0)
    expect(eventLog(h.events).filter((e) => e.startsWith("result"))).toEqual(["result:a"])
  })

  test("an executor rejection fails the loop after all calls stop", async () => {
    const h = harness({ throwOn: "b" })
    const done = runToolCalls(h.host, [call("a"), call("b"), call("c")], undefined)
    const failed = done.then(
      () => null,
      (error: unknown) => error,
    )
    await flush()
    h.release("b")
    expect(String(await failed)).toContain("boom b")
    // a got the abort while it ran; its result is saved (a prefix).
    expect(h.signals.get("a")?.aborted).toBe(true)
    expect(h.saved).toEqual(["a"])
    expect(h.running.size).toBe(0)
  })

  test("per-input check false: the call runs as a serial call", async () => {
    const h = harness()
    const done = runToolCalls(
      h.host,
      [call("a"), call("b", "Safe", { serial: true }), call("c")],
      undefined,
    )
    await flush()
    // b waits for a to be delivered; c is not admitted before b ends.
    expect(h.ports).toEqual(["start:a"])
    expect(h.admissions).toEqual(["admit:a", "admit:b"])
    h.release("a")
    await flush()
    expect(h.ports).toEqual(["start:a", "end:a", "start:b"])
    h.release("b")
    await flush()
    expect(h.admissions).toEqual(["admit:a", "admit:b", "admit:c"])
    h.release("c")
    const results = await done
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "b", "c"])
  })

  test("per-input check throws: the call runs as a serial call", async () => {
    const h = harness()
    h.host.executor = {
      ...h.host.executor,
      execute: h.host.executor.execute,
      concurrency: {
        toolFlag: () => ({ flag: true }),
        isCallConcurrencySafe: (_n, input) => {
          if (input.boom === true) throw new Error("no")
          return true
        },
      },
    }
    const done = runToolCalls(
      h.host,
      [call("a"), call("b", "Safe", { boom: true }), call("c")],
      undefined,
    )
    await flush()
    expect(h.ports).toEqual(["start:a"])
    h.releaseAll()
    await done
    expect(h.ports).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"])
  })

  test("durationMs is the admission time and the run time, not the wait for a slot or for delivery", async () => {
    const h = harness({ cap: 1 + 1 })
    const done = runToolCalls(h.host, [call("a"), call("b"), call("c")], undefined)
    await flush()
    // a and b run from t=0. b ends at t=10, a at t=50.
    h.clock.t = 10
    h.release("b")
    await flush()
    // c got the slot of b at t=10 and ends at t=15.
    h.clock.t = 15
    h.release("c")
    await flush()
    h.clock.t = 50
    h.release("a")
    await done
    const durations = h.events.flatMap((e) =>
      e.type === "tool_result" ? [`${e.id}=${e.durationMs}`] : [],
    )
    expect(durations).toEqual(["a=50", "b=10", "c=5"])
  })
})

describe("runToolCalls / wave failures and odd executors", () => {
  test("host.now throws: the run rejects, no hang", async () => {
    const h = harness()
    h.releaseAll()
    h.host.now = () => {
      throw new Error("clock broke")
    }
    const failed = runToolCalls(h.host, [call("a"), call("b")], undefined).then(
      () => null,
      (error: unknown) => error,
    )
    expect(String(await failed)).toContain("clock broke")
    expect(h.saved).toEqual([])
  })

  test("a wave call fails while a later call is in admission: the rethrow waits for that admission", async () => {
    let answer = () => {}
    let promptOpen = false
    const h = harness({
      throwOn: "a",
      admit: async (t) => {
        if (t.id !== "b") return true
        promptOpen = true
        await new Promise<void>((res) => {
          answer = res
        })
        promptOpen = false
        return true
      },
    })
    let settled = false
    const failed = runToolCalls(h.host, [call("a"), call("b"), call("c")], undefined).then(
      () => null,
      (error: unknown) => error,
    )
    void failed.then(() => {
      settled = true
    })
    await flush()
    expect(promptOpen).toBe(true)
    h.release("a")
    await flush()
    // The loop failed, but the admission of b (a human prompt with no
    // signal) still holds the rethrow.
    expect(settled).toBe(false)
    expect(h.signals.get("a")?.aborted).toBe(true)
    answer()
    expect(String(await failed)).toContain("boom a")
    // b never runs, c is never admitted, nothing is saved.
    expect(h.ports).not.toContain("start:b")
    expect(h.admissions).toEqual(["admit:a", "admit:b"])
    expect(h.saved).toEqual([])
  })

  test("an executor with a concurrency policy that calls no gates: no overlap, works as before", async () => {
    let running = 0
    let peak = 0
    const order: string[] = []
    const executor: ToolExecutor = {
      concurrency: POLICY,
      async execute(tool) {
        running++
        peak = Math.max(peak, running)
        await flush(1)
        running--
        order.push(tool.id)
        return { content: `ok ${tool.id}`, isError: false }
      },
    }
    const events: AgentEvent[] = []
    const host: ToolCallHost = {
      executor,
      persistence: null,
      emit: (e) => events.push(e),
      wantsToolOutput: false,
      now: () => 0,
      maxConcurrentToolCalls: 10,
    }
    const results = await runToolCalls(host, [call("a"), call("b"), call("c")], undefined)
    expect(peak).toBe(1)
    expect(order).toEqual(["a", "b", "c"])
    expect(results.map((r) => r.content)).toEqual(["ok a", "ok b", "ok c"])
    expect(events.flatMap((e) => (e.type === "tool_result" ? [e.id] : []))).toEqual(["a", "b", "c"])
  })

  test("the post-run section: one call at a time, in end order; the holder releases on return", async () => {
    const inSection: string[] = []
    let open = 0
    let peak = 0
    const runs = new Map<string, () => void>()
    const executor: ToolExecutor = {
      concurrency: POLICY,
      async execute(tool, _signal, ctx) {
        await ctx?.gates?.admitted({})
        await new Promise<void>((res) => runs.set(tool.id, res))
        await ctx?.gates?.ran()
        open++
        peak = Math.max(peak, open)
        inSection.push(tool.id)
        await flush(1)
        open--
        await ctx?.gates?.inCallOrder()
        return { content: `ok ${tool.id}`, isError: false }
      },
    }
    const saved: string[] = []
    const host: ToolCallHost = {
      executor,
      persistence: { appendToolResult: (r: ToolResultBlock) => saved.push(r.tool_use_id) } as never,
      emit: () => {},
      wantsToolOutput: false,
      now: () => 0,
      maxConcurrentToolCalls: 10,
    }
    const done = runToolCalls(host, [call("a"), call("b"), call("c")], undefined)
    await flush()
    for (const id of ["c", "a", "b"]) runs.get(id)?.()
    await done
    expect(inSection).toEqual(["c", "a", "b"])
    expect(peak).toBe(1)
    expect(saved).toEqual(["a", "b", "c"])
  })

  test("a later call fails in the section: earlier calls that ended their run keep their real results", async () => {
    const runs = new Map<string, () => void>()
    const inSection: string[] = []
    let failC: (error: Error) => void = () => {}
    const executor: ToolExecutor = {
      concurrency: POLICY,
      async execute(tool, _signal, ctx) {
        await ctx?.gates?.admitted({})
        await new Promise<void>((res) => runs.set(tool.id, res))
        await ctx?.gates?.ran()
        inSection.push(tool.id)
        if (tool.id === "c") {
          // c holds the section; its post-run step fails later.
          await new Promise<void>((_res, rej) => {
            failC = rej
          })
        }
        await ctx?.gates?.inCallOrder()
        return { content: `real ${tool.id}`, isError: false }
      },
    }
    const saved: ToolResultBlock[] = []
    const host: ToolCallHost = {
      executor,
      persistence: { appendToolResult: (r: ToolResultBlock) => saved.push(r) } as never,
      emit: () => {},
      wantsToolOutput: false,
      now: () => 0,
      maxConcurrentToolCalls: 10,
    }
    const done = runToolCalls(host, [call("a"), call("b"), call("c")], undefined)
    const failed = done.then(
      () => null,
      (error: unknown) => error,
    )
    await flush()
    // c ends its run first and holds the section; a and b end and wait.
    runs.get("c")?.()
    await flush()
    runs.get("a")?.()
    runs.get("b")?.()
    await flush()
    expect(inSection).toEqual(["c"])
    failC(new Error("boom c"))
    expect(String(await failed)).toContain("boom c")
    // a and b went through the section after the failure, in end order.
    expect(inSection).toEqual(["c", "a", "b"])
    expect(saved.map((r) => [r.tool_use_id, r.content])).toEqual([
      ["a", "real a"],
      ["b", "real b"],
    ])
  })

  test("the section goes to a waiter, then the loop fails before the waiter resumes: no post-run steps for it", async () => {
    // BUG 12b. b holds the section and c waits. In one synchronous step, b
    // leaves the section (c gets it) and the save of a throws (the loop
    // fails at a). c must not run its post-run steps (tool.didInvoke, the
    // blob write): its result is never saved.
    const runs = new Map<string, () => void>()
    const steps: string[] = []
    let gatesOfB: ToolCallGates | undefined
    let returnA: () => void = () => {}
    let holdB: () => void = () => {}
    const executor: ToolExecutor = {
      concurrency: POLICY,
      async execute(tool, signal, ctx) {
        const g = ctx?.gates as ToolCallGates
        await g.admitted({})
        await Promise.race([
          new Promise<void>((res) => runs.set(tool.id, res)),
          new Promise<void>((res) => signal?.addEventListener("abort", () => res())),
        ])
        await g.ran()
        steps.push(`didInvoke:${tool.id}`, `blob:${tool.id}`)
        if (tool.id === "b") {
          gatesOfB = g
          await new Promise<void>((res) => {
            holdB = res
          })
        }
        await g.inCallOrder()
        if (tool.id === "a") {
          await new Promise<void>((res) => {
            returnA = res
          })
        }
        return { content: `real ${tool.id}`, isError: false }
      },
    }
    const saved: ToolResultBlock[] = []
    const host: ToolCallHost = {
      executor,
      persistence: {
        appendToolResult: (r: ToolResultBlock) => {
          if (r.tool_use_id === "a") {
            // b leaves the section: c gets it. Then the save of a throws.
            void gatesOfB?.inCallOrder().catch(() => {})
            throw new Error("disk full")
          }
          saved.push(r)
        },
      } as never,
      emit: () => {},
      wantsToolOutput: false,
      now: () => 0,
      maxConcurrentToolCalls: 10,
    }
    const done = runToolCalls(host, [call("p"), call("a"), call("b"), call("c")], undefined)
    const failed = done.then(
      () => null,
      (error: unknown) => error,
    )
    await flush()
    runs.get("p")?.()
    await flush()
    expect(saved.map((r) => r.tool_use_id)).toEqual(["p"])
    runs.get("a")?.()
    await flush()
    runs.get("b")?.()
    await flush()
    runs.get("c")?.()
    await flush()
    // b holds the section, c waits for it.
    expect(steps).toEqual([
      "didInvoke:p",
      "blob:p",
      "didInvoke:a",
      "blob:a",
      "didInvoke:b",
      "blob:b",
    ])
    returnA()
    await flush()
    holdB()
    expect(String(await failed)).toContain("disk full")
    expect(steps).not.toContain("didInvoke:c")
    expect(steps).not.toContain("blob:c")
    // The earlier call keeps its real result.
    expect(saved.map((r) => [r.tool_use_id, r.content])).toEqual([["p", "real p"]])
  })
})

describe("runToolCalls / wall time with a fake clock", () => {
  /**
   * Ten calls of a fake 100 ms tool. A virtual clock moves to the next run
   * end when all started runs wait, so the wall time is exact and no timer
   * runs.
   */
  async function wallTime(cap: number): Promise<number> {
    let now = 0
    const ends: { at: number; wake: () => void }[] = []
    const executor: ToolExecutor = {
      concurrency: POLICY,
      async execute(_tool, _signal, ctx) {
        await ctx?.gates?.admitted({})
        await new Promise<void>((wake) => ends.push({ at: now + 100, wake }))
        await ctx?.gates?.ran()
        return { content: "ok", isError: false }
      },
    }
    const host: ToolCallHost = {
      executor,
      persistence: null,
      emit: () => {},
      wantsToolOutput: false,
      now: () => now,
      maxConcurrentToolCalls: cap,
    }
    let finished = false
    const done = runToolCalls(
      host,
      Array.from({ length: 10 }, (_, i) => call(`t${i}`)),
      undefined,
    ).then(() => {
      finished = true
    })
    while (!finished) {
      await flush(2)
      if (finished || ends.length === 0) continue
      ends.sort((x, y) => x.at - y.at)
      const at = (ends[0] as { at: number }).at
      now = at
      for (const e of ends.filter((x) => x.at === at)) e.wake()
      ends.splice(0, ends.filter((x) => x.at === at).length)
    }
    await done
    return now
  }

  test("cap 10: about 100 ms", async () => {
    expect(await wallTime(10)).toBe(100)
  })

  test("cap 1 (the serial path): about 1 s", async () => {
    expect(await wallTime(1)).toBe(1000)
  })
})

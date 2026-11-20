/**
 * The wave scheduler of the tool step (SPEC D2-D5, D9, X2, X3). `runToolCalls`
 * uses it only for a batch with a wave (two or more consecutive
 * concurrency-safe calls by the tool flag) and a concurrency cap above 1.
 *
 * Rules:
 *
 * - Wave: consecutive calls with the tool flag. At most `cap` runs at the
 *   same time; extra calls start in call order (FIFO slots).
 * - Serial call (no tool flag, or alone between serial calls): it starts
 *   after all earlier calls are delivered, and the next call starts after it
 *   is delivered. It runs with no gates, as on the serial path.
 * - Admission runs one call at a time in call order. `tool_call` and the
 *   `running_tool` status come before the admission of each call. After
 *   admission the per-input check gets the final input. False (or a throw)
 *   makes the call a serial call: it waits for all earlier calls, runs
 *   alone, and the next admission waits for it.
 * - Only the run overlaps. When the run of a call ends (`ran()`), the call
 *   enters the post-run section: one call at a time, in END order (the
 *   first call to end its run enters first). The result chain,
 *   `tool.didInvoke`, the blob write and the toolView `outcome` run there.
 *   Then `inCallOrder()` leaves the section and waits until all earlier
 *   calls are delivered, so the save and the `tool_output` / `tool_result`
 *   events go in call order. The saved results are always a prefix.
 * - Abort: running calls get the signal. A call that did not start gets
 *   the "tool aborted by user" result. The signal is checked again when a
 *   queued call gets its slot.
 * - A failure of the loop (an executor rejection, a save that throws):
 *   abort the running calls, wait until all settle, keep the results in
 *   call order up to the first call with no result, then rethrow.
 *
 * No timers: the waits are promises that the calls resolve.
 *
 * @module sdk/tool-call-waves
 */

import type { ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"

import type { ToolCallGates, ToolConcurrencyPolicy, ToolExecResult } from "./ports.ts"
import { deliverToolResult, skipAbortedTool, type ToolCallHost, toolFlagOf } from "./tool-calls.ts"
import { summarizeToolInput, toolCallEvent } from "./tool-facts.ts"

/** The scheduler options. */
export interface WaveOptions {
  /** Concurrency cap: the largest number of runs at the same time (2 or more). */
  cap: number
  /** The two-step concurrency-safe decision. */
  policy: ToolConcurrencyPolicy
}

/** A queued call that did not start because the run was aborted. */
class QueuedCallAborted extends Error {
  constructor() {
    super("tool call aborted before it started")
    this.name = "QueuedCallAborted"
  }
}

/** An earlier call of the batch has no result because the loop failed. */
class BatchFailed extends Error {
  constructor() {
    super("an earlier tool call of the batch failed")
    this.name = "BatchFailed"
  }
}

/** A promise with its settle functions. */
interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}

function deferred(): Deferred {
  let resolve: () => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  // A rejection with no reader is expected (a call after a failure that
  // never starts). Mark it as handled.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/**
 * Run slots of a wave. A waiter gets a slot in the order it asked (call
 * order, because admission is in call order).
 */
class RunSlots {
  private running = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly cap: number) {}

  acquire(): Promise<void> {
    if (this.running < this.cap) {
      this.running++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.running--
  }
}

/**
 * The post-run section of a batch: one call at a time, in the order the
 * calls ask for it. A call asks when its run ends, so the order is END
 * order. A call releases only the section that it holds. A waiter that
 * leaves the queue owns nothing.
 */
class PostRunSection {
  private holder: number | null = null
  private readonly waiters: { k: number; enter(): void; drop(error: unknown): void }[] = []

  /**
   * Wait until call `k` holds the section. When `aborted` is true and the
   * section is busy, reject at once with `whenAborted`.
   */
  enter(k: number, aborted: boolean, whenAborted: () => unknown): Promise<void> {
    if (this.holder === null) {
      this.holder = k
      return Promise.resolve()
    }
    if (aborted) return Promise.reject(whenAborted())
    return new Promise<void>((enter, drop) => this.waiters.push({ k, enter, drop }))
  }

  /** Call `k` leaves the section. No-op when `k` does not hold it. */
  release(k: number): void {
    if (this.holder !== k) return
    const next = this.waiters.shift()
    this.holder = next ? next.k : null
    next?.enter()
  }

  /** The waiters of call `from` and later leave the queue: `enter` rejects. */
  drop(from: number, error: () => unknown): void {
    const dropped = this.waiters.filter((w) => w.k >= from)
    const kept = this.waiters.filter((w) => w.k < from)
    this.waiters.splice(0, this.waiters.length, ...kept)
    for (const w of dropped) w.drop(error())
  }
}

/** The per-input check of a call. A throw gives false (a serial call). */
function isCallSafe(
  policy: ToolConcurrencyPolicy,
  name: string,
  input: Record<string, unknown>,
): boolean {
  try {
    return policy.isCallConcurrencySafe(name, input) === true
  } catch {
    return false
  }
}

/**
 * Which calls are in a wave: the call has the tool flag, and the call
 * before or after it has the flag too. A flagged call alone between serial
 * calls runs as a serial call (it looks as today).
 */
export function waveMembership(
  policy: ToolConcurrencyPolicy,
  toolBlocks: readonly ToolUseBlock[],
): boolean[] {
  const flags = toolBlocks.map((t) => toolFlagOf(policy, t.name))
  return flags.map((f, k) => f && (flags[k - 1] === true || flags[k + 1] === true))
}

/**
 * Run the tool calls of one batch in waves. Returns the results in call
 * order (`results[i].tool_use_id === toolBlocks[i].id`).
 */
export async function runToolCallsInWaves(
  host: ToolCallHost,
  toolBlocks: readonly ToolUseBlock[],
  signal: AbortSignal | undefined,
  opts: WaveOptions,
): Promise<ToolResultBlock[]> {
  const n = toolBlocks.length
  const inWave = waveMembership(opts.policy, toolBlocks)
  const results: (ToolResultBlock | undefined)[] = toolBlocks.map(() => undefined)
  /** `delivered[k]`: result k is saved and its events are out. */
  const delivered = toolBlocks.map(() => deferred())
  /** All calls before `k` are delivered. Rejects when the loop failed. */
  const earlierDelivered = (k: number): Promise<void> =>
    k === 0 ? Promise.resolve() : (delivered[k - 1] as Deferred).promise
  // One signal for the runs: the abort signal of the run, or a failure of the loop.
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  const runSignal = controller.signal
  const section = new PostRunSection()
  /** The first call with no result because the loop failed (`n`: none). */
  let failedFrom = n
  // A user abort while a call waits for the post-run section: it leaves the
  // queue and gets the aborted result. It owns nothing, so it releases nothing.
  // A failure of the loop (SPEC D9(3)) drops only the waiters from the failed
  // call on (`fail` sets `failedFrom` before the abort): an earlier call that
  // ended its run keeps its place and its real result.
  runSignal.addEventListener(
    "abort",
    () => section.drop(failedFrom === n ? 0 : failedFrom, () => new QueuedCallAborted()),
    { once: true },
  )
  const slots = new RunSlots(opts.cap)
  let failure: { error: unknown } | null = null
  /** The loop failed at call `k`: abort the runs, no result from `k` on. */
  const fail = (k: number, error: unknown): void => {
    if (failure === null) failure = { error }
    failedFrom = Math.min(failedFrom, k)
    // A call of `k` or later that waits for the post-run section leaves the
    // queue first: its result will not be saved. The earlier waiters stay:
    // their runs ended, so they get their real results in call order.
    section.drop(k, () => new BatchFailed())
    controller.abort()
    for (let j = k; j < n; j++) (delivered[j] as Deferred).reject(new BatchFailed())
  }
  /** Settle call `k` after its delivery attempt. */
  const settle = (k: number, deliver: () => ToolResultBlock): void => {
    try {
      results[k] = deliver()
      ;(delivered[k] as Deferred).resolve()
    } catch (error) {
      fail(k, error)
    }
  }

  /** A call that did not start: wait for its place in call order, then the aborted result. */
  const skipCall = async (k: number, tool: ToolUseBlock, inputSummary: string): Promise<void> => {
    try {
      await earlierDelivered(k)
    } catch {
      return
    }
    settle(k, () => skipAbortedTool(host, tool, inputSummary))
  }

  /** Run call `k` through the executor; `admissionDone` lets the next admission go. */
  const runCall = async (
    k: number,
    tool: ToolUseBlock,
    inputSummary: string,
    serial: boolean,
    admissionDone: Deferred,
  ): Promise<void> => {
    let holdsSlot = false
    /** Start of the call (its admission starts here). */
    let execStart: number | undefined
    /** The time of the admission (set by `admitted`). */
    let admissionMs: number | undefined
    let runStart: number | undefined
    let runEnd: number | undefined
    const releaseSlot = () => {
      if (!holdsSlot) return
      holdsSlot = false
      slots.release()
    }
    /**
     * Enter the post-run section. A call after a loop failure cannot. Only a
     * user abort makes a call skip a busy section; after a loop failure an
     * earlier call waits for its turn and keeps its real result.
     */
    const enterSection = async (): Promise<void> => {
      if (k >= failedFrom) throw new BatchFailed()
      await section.enter(k, signal?.aborted === true, () => new QueuedCallAborted())
    }
    const gates: ToolCallGates = {
      admitted: async (input) => {
        const admittedAt = host.now()
        admissionMs = admittedAt - (execStart ?? admittedAt)
        if (input === null) {
          // Refused by admission: no run. Its time is the admission time.
          admissionDone.resolve()
          return false
        }
        const safe = isCallSafe(opts.policy, tool.name, input)
        if (safe) {
          admissionDone.resolve()
          await slots.acquire()
          holdsSlot = true
        } else {
          // A serial call after admission: wait for all earlier calls, run
          // alone. The next admission waits until this call is delivered.
          await earlierDelivered(k)
        }
        if (runSignal.aborted) {
          releaseSlot()
          throw new QueuedCallAborted()
        }
        runStart = host.now()
        return safe
      },
      ran: async () => {
        if (runStart !== undefined) runEnd = host.now()
        releaseSlot()
        await enterSection()
      },
      inCallOrder: async () => {
        section.release(k)
        await earlierDelivered(k)
      },
    }
    try {
      execStart = host.now()
      const context = host.context?.() ?? {}
      let result: ToolExecResult
      try {
        result = await host.executor.execute(
          tool,
          runSignal,
          serial ? context : { ...context, gates, concurrent: true },
        )
      } catch (error) {
        // Fail first: the waiters of this call and later leave the queue
        // before this call releases the section.
        if (!(error instanceof QueuedCallAborted || error instanceof BatchFailed)) fail(k, error)
        section.release(k)
        throw error
      }
      // Never wait for an earlier call while this call holds the section.
      section.release(k)
      const execEnd = host.now()
      try {
        await earlierDelivered(k)
      } catch {
        return
      }
      // durationMs = the admission time and the run time of this call, not
      // the wait for a slot or for delivery (the same meaning as on the
      // serial path). With no gates called: the time of the whole call.
      const durationMs =
        admissionMs === undefined
          ? execEnd - execStart
          : admissionMs + (runStart === undefined ? 0 : (runEnd ?? execEnd) - runStart)
      settle(k, () => deliverToolResult(host, tool, inputSummary, result, Math.max(0, durationMs)))
    } catch (error) {
      if (error instanceof QueuedCallAborted) await skipCall(k, tool, inputSummary)
      else if (error instanceof BatchFailed) return
      else fail(k, error)
    } finally {
      releaseSlot()
      section.release(k)
      admissionDone.resolve()
    }
  }

  const tasks: Promise<void>[] = []
  // The admission pipeline: one call at a time, in call order.
  for (let k = 0; k < n; k++) {
    if (failure !== null) break
    const tool = toolBlocks[k] as ToolUseBlock
    const serial = inWave[k] !== true
    try {
      // A serial call starts after all earlier calls are delivered.
      if (serial) await earlierDelivered(k)
    } catch {
      break
    }
    const admissionDone = deferred()
    try {
      const inputSummary = summarizeToolInput(tool.input)
      host.emit(toolCallEvent(tool, inputSummary))
      if (runSignal.aborted) {
        tasks.push(skipCall(k, tool, inputSummary))
        continue
      }
      host.emit({ type: "status", phase: "running_tool", toolName: tool.name })
      tasks.push(runCall(k, tool, inputSummary, serial, admissionDone))
    } catch (error) {
      fail(k, error)
      break
    }
    // A wave call lets the next admission go when its own admission ends.
    // A serial call (by flag or by input) lets it go when it is delivered.
    await admissionDone.promise
  }
  // Never a bare Promise.all: wait for every call to stop.
  await Promise.allSettled(tasks)
  signal?.removeEventListener("abort", onAbort)
  if (failure !== null) throw (failure as { error: unknown }).error
  return results.map((r, k) => {
    if (r === undefined) throw new Error(`tool call ${k} has no result`)
    return r
  })
}

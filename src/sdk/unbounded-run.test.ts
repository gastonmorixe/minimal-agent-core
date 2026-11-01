/**
 * The unbounded run policy (spec v2 section 2.2) through `AgentCore.run`
 * with a fake transport and a fake clock, so no test really waits.
 *
 * - Transient errors retry forever with backoff; each wait emits one
 *   `status` event. Nothing names a cap.
 * - `Retry-After` wins over backoff.
 * - A recoverable error runs its recovery, then retries.
 * - A permanent error pauses the run (`waiting`); the next run resumes it.
 *
 * @module sdk/unbounded-run.test
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { RetryClock } from "../llm/transport/retry-policy.ts"
import type { StreamedResponse, TransportFn } from "../llm/transport/types.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import type { AgentEvent } from "./events.ts"
import type { AgentCoreConfig } from "./ports.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/** A clock that records every sleep and never waits. */
function fakeClock(): RetryClock & { sleeps: number[] } {
  let now = 1_000_000
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
  }
}

function core(sendFn: TransportFn, clock: RetryClock, over: Partial<AgentCoreConfig> = {}) {
  const events: AgentEvent[] = []
  const agent = new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    eventSink: { emit: (e) => events.push(e) },
    sendFn,
    retry: { clock, random: () => 0.5 },
    ...over,
  })
  return { agent, events }
}

async function drain(gen: AsyncGenerator<string, TurnResult, undefined>): Promise<TurnResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

const ok: StreamedResponse = {
  blocks: [{ type: "text", text: "done" }],
  text: "done",
  stopReason: "end_turn",
}

/** A transport that throws `fail(n)` for the first `failures` calls, then answers. */
function flaky(
  failures: number,
  fail: (n: number) => Error,
): TransportFn & { calls: () => number } {
  let calls = 0
  const fn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    calls++
    if (calls <= failures) throw fail(calls)
    yield "done"
    return ok
  }
  return Object.assign(fn, { calls: () => calls })
}

const capWord = /\bcap(ped)?\b|limit|budget|exhaust/i

describe("AgentCore.run unbounded retry (S16)", () => {
  it("survives 50 transient failures, then completes; nothing names a cap", async () => {
    const clock = fakeClock()
    const sendFn = flaky(50, (n) =>
      Object.assign(new Error(`overloaded ${n}`), { errorClass: "transient" }),
    )
    const { agent, events } = core(sendFn, clock)

    const result = await drain(agent.run("go"))

    expect(result.outcome).toBe("completed")
    expect(sendFn.calls()).toBe(51)
    // One status event per wait, with the next attempt and its delay.
    const waits = events.filter((e) => e.type === "status")
    expect(waits).toHaveLength(50)
    expect(waits[0]).toMatchObject({ phase: "retrying", attempt: 2, cause: "transient" })
    expect(waits[49]).toMatchObject({ phase: "retrying", attempt: 51 })
    expect(clock.sleeps).toHaveLength(50)
    // Backoff grows, then holds at the 60 s ceiling (full jitter, random 0.5).
    expect(Math.max(...clock.sleeps)).toBe(30_000)
    expect(events.some((e) => e.type === "error")).toBe(false)
    for (const e of events) expect(JSON.stringify(e)).not.toMatch(capWord)
    expect(result.outcome).not.toMatch(capWord)
  })

  it("never throws on a long transient outage of a tagged wire error", async () => {
    const clock = fakeClock()
    // An older vendored adapter: a retry tag and no class field.
    const sendFn = flaky(200, () =>
      Object.assign(new Error("429"), { streamErrorType: "rate_limit_error" }),
    )
    const { agent } = core(sendFn, clock)
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(sendFn.calls()).toBe(201)
  })

  it("lets Retry-After win over backoff", async () => {
    const clock = fakeClock()
    const sendFn = flaky(2, () =>
      Object.assign(new Error("429"), {
        errorClass: "transient",
        streamErrorType: "rate_limit_error",
        retryAfterMs: 7_000,
      }),
    )
    const { agent, events } = core(sendFn, clock)
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    // Backoff for rate_limit_error with random 0.5 would be 15 s, then 30 s.
    expect(clock.sleeps).toEqual([7_000, 7_000])
    const waits = events.filter((e) => e.type === "status")
    expect(waits.map((e) => (e.type === "status" ? e.nextDelayMs : -1))).toEqual([7_000, 7_000])
  })

  it("waits for a known quota reset, then retries (waiting_for_quota)", async () => {
    const clock = fakeClock()
    const resetAt = clock.now() + 3_600_000
    const sendFn = flaky(1, () =>
      Object.assign(new Error("quota"), {
        errorClass: "recoverable",
        recovery: "wait_for_quota",
        resetAt,
        streamErrorType: "rate_limit_error",
      }),
    )
    const { agent, events } = core(sendFn, clock)
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(clock.sleeps).toEqual([3_600_000])
    const wait = events.find((e) => e.type === "status")
    expect(wait).toMatchObject({ phase: "waiting_for_quota", resetAt, nextDelayMs: 3_600_000 })
  })

  it("compacts on a context overflow, then retries", async () => {
    const clock = fakeClock()
    const sendFn = flaky(1, () =>
      Object.assign(new Error("prompt too long"), {
        errorClass: "recoverable",
        recovery: "compact",
      }),
    )
    const { agent } = core(sendFn, clock)
    let compacts = 0
    agent.compact = async () => {
      compacts++
      return { kind: "local" } as Awaited<ReturnType<AgentCore["compact"]>>
    }
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(compacts).toBe(1)
    expect(sendFn.calls()).toBe(2)
  })

  it("pauses when a recovery did not help, and the next run resumes the session", async () => {
    const clock = fakeClock()
    // Two 401s: the refresh recovery runs once, the second 401 pauses the run.
    const sendFn = flaky(2, () =>
      Object.assign(new Error("401 unauthorized"), {
        errorClass: "recoverable",
        recovery: "refresh_credential",
      }),
    )
    const { agent, events } = core(sendFn, clock)
    const paused = await drain(agent.run("go"))
    expect(paused.outcome).toBe("waiting")
    expect(sendFn.calls()).toBe(2)
    const tail = events.slice(-3)
    expect(tail[0]).toMatchObject({ type: "error", recoverable: false })
    expect(tail[1]).toMatchObject({ type: "status", phase: "waiting_for_host" })
    expect(tail[2]).toEqual({ type: "run_finished", outcome: "waiting" })

    // The host fixed the cause; the next run continues on the same history.
    const resumed = await drain(agent.run(""))
    expect(resumed.outcome).toBe("completed")
    expect(agent.history().at(-1)).toMatchObject({ role: "assistant" })
  })

  it("pauses on a permanent error without throwing (waiting_for_host)", async () => {
    const clock = fakeClock()
    const sendFn = flaky(1, () =>
      Object.assign(new Error("model not found"), { errorClass: "permanent", code: "x.nf" }),
    )
    const { agent, events } = core(sendFn, clock)
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("waiting")
    expect((result.error as Error).message).toBe("model not found")
    expect(clock.sleeps).toEqual([])
    expect(events.filter((e) => e.type === "error")).toEqual([
      { type: "error", message: "model not found", code: "x.nf", recoverable: false },
    ])
    expect(events.at(-2)).toEqual({ type: "status", phase: "waiting_for_host", cause: "permanent" })
    expect(events.at(-1)).toEqual({ type: "run_finished", outcome: "waiting" })
  })

  it("stops a retry wait on abort (row 1)", async () => {
    const ac = new AbortController()
    const clock: RetryClock = {
      now: () => 0,
      sleep: async () => {
        ac.abort()
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      },
    }
    const sendFn = flaky(5, () => Object.assign(new Error("blip"), { errorClass: "transient" }))
    const { agent, events } = core(sendFn, clock)
    await expect(drain(agent.run("go", { signal: ac.signal }))).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(sendFn.calls()).toBe(1)
    // Row 1: `error` "aborted", then `run_finished` (spec v2 2.1 row 1).
    expect(events.at(-2)).toEqual({ type: "error", message: "aborted" })
    expect(events.at(-1)).toEqual({ type: "run_finished", outcome: "aborted" })
  })
})

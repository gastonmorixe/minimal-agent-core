/**
 * Turn wrap-up through `AgentCore.run`: a wrap-up abort is not a user
 * abort. The loop runs exactly ONE final turn (the host note, the host tool
 * list, short timeouts, at most one retry), runs its tool calls, and ends
 * the run with outcome `truncated`.
 *
 * @module sdk/wrap-up.test
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics, type Diagnostics } from "../diagnostics/hub.ts"
import type { CanonicalEvent } from "../llm/canonical-events.ts"
import { assembleStreamedResponse } from "../llm/codec/stream-assembler.ts"
import type { Message } from "../llm/messages.ts"
import type { RetryClock } from "../llm/transport/retry-policy.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import type { AgentEvent } from "./events.ts"
import type { TurnEndPayload } from "./lifecycle.ts"
import type { AgentCoreConfig, ToolExecResult } from "./ports.ts"
import {
  WRAP_UP_DEADLINE_MS,
  WRAP_UP_HEADERS_TIMEOUT_MS,
  WRAP_UP_MAX_ATTEMPTS,
  WRAP_UP_MIN_BUDGET_MS,
  WRAP_UP_REASON,
  WrapUpAbortError,
  type WrapUpReason,
  wrapUpBudgetMs,
  wrapUpContent,
  wrapUpTools,
} from "./wrap-up.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const NOTE = "Your time is finished. Report now."
const REASON: WrapUpReason = { ...WRAP_UP_REASON, tools: ["Report"], text: NOTE }

const TOOLS = [
  { name: "Bash", description: "d", input_schema: {} },
  { name: "Report", description: "d", input_schema: {} },
]

/** A clock whose sleep waits until the signal aborts (a long backoff). */
const blockingClock: RetryClock = {
  now: () => 0,
  sleep: (_ms, signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    }),
}

function toolUse(id: string, name: string): StreamedResponse {
  return {
    blocks: [{ type: "tool_use", id, name, input: {} }],
    text: "",
    stopReason: "tool_use",
  }
}

const reported: StreamedResponse = toolUse("r1", "Report")

/** One recorded send: the options and a copy of the history. */
interface Sent {
  opts: SendOptions
  messages: Message[]
}

/** The real codec (sibling checkout), else `NO_SIDEBAND`. Note pins skip without it. */
const SB = fixtureSidebandOrNone()
const itSb = it.skipIf(!sidebandFixturePresent())

function core(
  sendFn: TransportFn,
  execute: (name: string, signal?: AbortSignal) => Promise<ToolExecResult>,
  extra: Partial<AgentCoreConfig> = {},
) {
  const events: AgentEvent[] = []
  const agent = new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => TOOLS },
    toolExecutor: { execute: (tool, signal) => execute(tool.name, signal) },
    eventSink: { emit: (e) => events.push(e) },
    sendFn,
    retry: { clock: blockingClock, random: () => 0.5 },
    sideband: SB,
    ...extra,
  })
  return { agent, events }
}

async function drain(gen: AsyncGenerator<string, TurnResult, undefined>): Promise<TurnResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

/** A transport: the first sends follow `first`, the final send answers `final`. */
function transport(
  sent: Sent[],
  onSend: (n: number, opts: SendOptions) => Promise<StreamedResponse>,
): TransportFn {
  return async function* (opts: SendOptions) {
    sent.push({ opts, messages: structuredClone(opts.messages) })
    yield ""
    return await onSend(sent.length, opts)
  }
}

function hangUntil(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    if (signal?.aborted) fail()
    signal?.addEventListener("abort", fail, { once: true })
  })
}

const transientError = (): Error =>
  Object.assign(new Error("overloaded"), { streamErrorType: "overloaded_error" })

describe("wrapUpTools / wrapUpContent", () => {
  it("keeps only the host tools, or all tools when none match", () => {
    expect(wrapUpTools(TOOLS, ["Report"])?.map((t) => t.name)).toEqual(["Report"])
    expect(wrapUpTools(TOOLS, ["Nope"])?.map((t) => t.name)).toEqual(["Bash", "Report"])
    expect(wrapUpTools(TOOLS, undefined)?.length).toBe(2)
    expect(wrapUpTools(undefined, ["Report"])).toBeUndefined()
  })

  itSb("wraps the host note, and gives no block without a note", () => {
    expect(wrapUpContent(SB, REASON)).toEqual([
      { type: "text", text: `<ma::agent::wrap-up>${NOTE}</ma::agent::wrap-up>` },
    ])
    expect(wrapUpContent(SB, WRAP_UP_REASON)).toEqual([])
  })

  it("gives no block with no codec (NO_SIDEBAND), also with a note", () => {
    expect(wrapUpContent(NO_SIDEBAND, REASON)).toEqual([])
    expect(wrapUpContent(NO_SIDEBAND, WRAP_UP_REASON)).toEqual([])
  })
})

describe("AgentCore.run wrap-up", () => {
  itSb("a wrap-up during the retry backoff runs exactly one final turn", async () => {
    const sent: Sent[] = []
    const ac = new AbortController()
    const executed: string[] = []
    const { agent, events } = core(
      transport(sent, async (n) => {
        if (n === 1) {
          setTimeout(() => ac.abort(REASON), 5)
          throw transientError()
        }
        return reported
      }),
      async (name) => {
        executed.push(name)
        return { content: "ok", isError: false }
      },
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))

    expect(result.outcome).toBe("truncated")
    expect(sent.length).toBe(2)
    const final = sent[1] as Sent
    expect(final.opts.tools?.map((t) => t.name)).toEqual(["Report"])
    expect(final.opts.responseHeadersTimeoutMs).toBe(WRAP_UP_HEADERS_TIMEOUT_MS)
    expect(final.opts.signal).not.toBe(ac.signal)
    const lastMsg = final.messages[final.messages.length - 1] as Message
    expect(JSON.stringify(lastMsg.content)).toContain(NOTE)
    expect(executed).toEqual(["Report"])
    // Not a user abort: no `error` "aborted", and the run ends truncated.
    expect(events.some((e) => e.type === "error")).toBe(false)
    expect(events.filter((e) => e.type === "run_finished")).toEqual([
      { type: "run_finished", outcome: "truncated" },
    ])
    expect(events.filter((e) => e.type === "turn_started").length).toBe(2)
  })

  it("a wrap-up during a tool run closes the call and does not run it again", async () => {
    const sent: Sent[] = []
    const ac = new AbortController()
    const executed: string[] = []
    const { agent } = core(
      transport(sent, async (n) => (n === 1 ? toolUse("b1", "Bash") : reported)),
      async (name, signal) => {
        executed.push(name)
        if (name === "Bash") {
          setTimeout(() => ac.abort(REASON), 5)
          try {
            await hangUntil(signal)
          } catch {
            return { content: "aborted", isError: true }
          }
        }
        return { content: "ok", isError: false }
      },
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))

    expect(result.outcome).toBe("truncated")
    expect(executed).toEqual(["Bash", "Report"])
    expect(sent.length).toBe(2)
    // The Bash call has exactly one result in the final request.
    const results = (sent[1] as Sent).messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result" && b.tool_use_id === "b1")
    expect(results.length).toBe(1)
  })

  it("the final turn retries at most once, then ends", async () => {
    const sent: Sent[] = []
    const ac = new AbortController()
    const { agent } = core(
      transport(sent, async (n, opts) => {
        if (n === 1) {
          setTimeout(() => ac.abort(REASON), 5)
          return await hangUntil(opts.signal)
        }
        throw transientError()
      }),
      async () => ({ content: "ok", isError: false }),
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    expect(sent.length).toBe(1 + WRAP_UP_MAX_ATTEMPTS)
  })

  it("a user abort still ends the run as aborted", async () => {
    const ac = new AbortController()
    const { agent, events } = core(
      transport([], async (_n, opts) => {
        setTimeout(() => ac.abort(), 5)
        return await hangUntil(opts.signal)
      }),
      async () => ({ content: "ok", isError: false }),
    )
    await expect(drain(agent.run("go", { signal: ac.signal }))).rejects.toThrow("aborted")
    expect(events.filter((e) => e.type === "run_finished")).toEqual([
      { type: "run_finished", outcome: "aborted" },
    ])
  })
})

/** A diagnostics handle that records each event. */
function recordingDiagnostics(): { diagnostics: Diagnostics; logs: LogEvent[] } {
  const logs: LogEvent[] = []
  return { diagnostics: createDiagnostics({ emit: (e) => logs.push(e) }), logs }
}

/** The `budgetMs` of the `agent.wrap-up` diagnostic. */
function budgetOf(logs: LogEvent[]): unknown {
  return logs.find((l) => l.source === "agent.wrap-up")?.structuredData?.budgetMs
}

describe("wrapUpBudgetMs", () => {
  it("is the smaller of the core limit and the host deadline", () => {
    expect(wrapUpBudgetMs(WRAP_UP_REASON, 0)).toBe(WRAP_UP_DEADLINE_MS)
    expect(wrapUpBudgetMs({ ...WRAP_UP_REASON, deadlineAt: 100_000 }, 0)).toBe(WRAP_UP_DEADLINE_MS)
    expect(wrapUpBudgetMs({ ...WRAP_UP_REASON, deadlineAt: 42_000 }, 10_000)).toBe(32_000)
    expect(wrapUpBudgetMs({ ...WRAP_UP_REASON, deadlineAt: 5_000 }, 10_000)).toBe(
      WRAP_UP_MIN_BUDGET_MS,
    )
  })
})

describe("AgentCore.run wrap-up: review cases", () => {
  it("MAJ-2: a tool that is slow to obey the abort reduces the final-turn budget", async () => {
    let t = 0
    const clock: RetryClock = { ...blockingClock, now: () => t }
    const ac = new AbortController()
    const sent: Sent[] = []
    const { diagnostics, logs } = recordingDiagnostics()
    const { agent } = core(
      transport(sent, async (n) => (n === 1 ? toolUse("b1", "Bash") : reported)),
      async (name, signal) => {
        if (name === "Bash") {
          // SIGTERM at t=0: the host ends the process at 45 s - 3 s.
          setTimeout(() => ac.abort({ ...REASON, deadlineAt: 42_000 }), 5)
          await hangUntil(signal).catch(() => {})
          t += 10_000 // the tool obeys the abort 10 s late
          return { content: "aborted", isError: true }
        }
        return { content: "ok", isError: false }
      },
      { diagnostics, retry: { clock, random: () => 0.5 } },
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    expect(budgetOf(logs)).toBe(32_000)
    expect(sent.length).toBe(2)
  })

  it("MAJ-2: with less than the retry minimum left, a transient error gets no retry", async () => {
    let t = 0
    const clock: RetryClock = { ...blockingClock, now: () => t }
    const ac = new AbortController()
    const sent: Sent[] = []
    const { diagnostics, logs } = recordingDiagnostics()
    const { agent } = core(
      transport(sent, async (n, opts) => {
        if (n === 1) {
          setTimeout(() => ac.abort({ ...REASON, deadlineAt: 8_000 }), 5)
          return await hangUntil(opts.signal)
        }
        t += 100
        throw transientError()
      }),
      async () => ({ content: "ok", isError: false }),
      { diagnostics, retry: { clock, random: () => 0.5 } },
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    expect(budgetOf(logs)).toBe(8_000)
    expect(sent.length).toBe(2)
  })

  it("MIN-3: the final turn does not retry a permanent error", async () => {
    const sent: Sent[] = []
    const ac = new AbortController()
    const { agent } = core(
      transport(sent, async (n, opts) => {
        if (n === 1) {
          setTimeout(() => ac.abort(REASON), 5)
          return await hangUntil(opts.signal)
        }
        throw Object.assign(new Error("bad request"), { errorClass: "permanent" })
      }),
      async () => ({ content: "ok", isError: false }),
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    expect(sent.length).toBe(2)
  })

  it("#2: a mid-stream wrap-up after text runs no tool and sends one more POST", async () => {
    const sent: Sent[] = []
    const ac = new AbortController()
    const executed: string[] = []
    const sendFn: TransportFn = async function* (opts: SendOptions) {
      sent.push({ opts, messages: structuredClone(opts.messages) })
      if (sent.length === 1) {
        // The stream gives only text, then SIGTERM cuts it (no tool_use yet).
        yield "partial"
        ac.abort(REASON)
        return await hangUntil(opts.signal)
      }
      yield ""
      return reported
    }
    const { agent, events } = core(sendFn, async (name) => {
      executed.push(name)
      return { content: "ok", isError: false }
    })
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    expect(sent.length).toBe(2)
    expect(executed).toEqual(["Report"])
    // The cut response is not in history: the final request has no tool_use.
    const blocks = (sent[1] as Sent).messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    )
    expect(blocks.some((b) => b.type === "tool_use")).toBe(false)
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  it("#3: a wrap-up between rounds (after the tool results) sends one final turn", async () => {
    const sent: Sent[] = []
    const ac = new AbortController()
    const executed: string[] = []
    const { agent } = core(
      transport(sent, async (n) => (n === 1 ? toolUse("b1", "Bash") : reported)),
      async (name) => {
        executed.push(name)
        // The tool completes, then SIGTERM comes before the next round.
        if (name === "Bash") ac.abort(REASON)
        return { content: "ok", isError: false }
      },
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    expect(executed).toEqual(["Bash", "Report"])
    expect(sent.length).toBe(2)
    // The Bash result is the real one, not a synthetic stop result.
    const results = (sent[1] as Sent).messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result" && b.tool_use_id === "b1")
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results[0])).toContain("ok")
  })

  it("MIN-1: a wrap-up before the round request exists ends as a plain abort", async () => {
    const ac = new AbortController()
    const sent: Sent[] = []
    const { agent, events } = core(
      transport(sent, async () => reported),
      async () => ({ content: "ok", isError: false }),
      {
        // The SIGTERM comes while the first user message is built, and the
        // resolver obeys the abort.
        mediaResolver: {
          resolveUserContent: async () => {
            ac.abort(REASON)
            throw Object.assign(new Error("aborted"), { name: "AbortError" })
          },
        },
      },
    )
    await expect(drain(agent.run("go", { signal: ac.signal }))).rejects.toThrow()
    expect(sent.length).toBe(0)
    expect(events.filter((e) => e.type === "run_finished")).toEqual([
      { type: "run_finished", outcome: "aborted" },
    ])
  })

  it("MIN-2: turnEnd is an aborted turn, not a failed turn", async () => {
    const ends: TurnEndPayload[] = []
    const ac = new AbortController()
    const { agent } = core(
      transport([], async (n, opts) => {
        if (n === 1) {
          setTimeout(() => ac.abort(REASON), 5)
          return await hangUntil(opts.signal)
        }
        return reported
      }),
      async () => ({ content: "ok", isError: false }),
      { lifecycle: { turnEnd: (p) => void ends.push(p) } },
    )
    await drain(agent.run("go", { signal: ac.signal }))
    expect(ends).toEqual([{ ok: false, aborted: true, error: "wrap_up" }])
  })

  it("MIN-2: a throw in the final turn still gives run_finished truncated", async () => {
    const ac = new AbortController()
    const { diagnostics, logs } = recordingDiagnostics()
    const { agent, events } = core(
      transport([], async (n, opts) => {
        if (n === 1) {
          setTimeout(() => ac.abort(REASON), 5)
          return await hangUntil(opts.signal)
        }
        return reported
      }),
      async (name) => {
        if (name === "Report") throw new Error("tool step broke")
        return { content: "ok", isError: false }
      },
      {
        diagnostics,
        // The record step throws (a broken session log).
        sessionPersistence: {
          appendUser: () => "id",
          appendAssistant: () => {
            throw new Error("log write failed")
          },
          appendToolResult: () => {},
          appendNote: () => {},
          appendRewind: () => {},
        },
      },
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    expect(events.filter((e) => e.type === "run_finished")).toEqual([
      { type: "run_finished", outcome: "truncated" },
    ])
    expect(logs.some((l) => l.source === "agent.wrap-up-failed")).toBe(true)
  })

  it("#2: a cut AFTER a complete tool_use block runs no tool and sends exactly one more POST", async () => {
    const sent: Sent[] = []
    const ac = new AbortController()
    const executed: string[] = []
    const sendFn: TransportFn = async function* (opts: SendOptions) {
      sent.push({ opts, messages: structuredClone(opts.messages) })
      if (sent.length > 1) {
        yield ""
        return reported
      }
      // The real assembler: a complete tool_use block (start, input, stop),
      // then SIGTERM cuts the stream before message_stop.
      async function* wire(): AsyncIterable<CanonicalEvent> {
        yield {
          type: "message_start",
          messageId: "m1",
          modelId: "test-model",
          initialUsage: { inputTokens: 1, outputTokens: 0 },
        }
        yield { type: "text_start", index: 0 }
        yield { type: "text_delta", index: 0, text: "I run Bash." }
        yield { type: "text_stop", index: 0 }
        yield { type: "tool_use_start", index: 1, id: "b1", name: "Bash" }
        yield { type: "tool_use_input_delta", index: 1, partialJson: '{"command":"rm x"}' }
        yield { type: "tool_use_stop", index: 1 }
        ac.abort(REASON)
        await hangUntil(opts.signal)
      }
      return yield* assembleStreamedResponse(wire())
    }
    const { agent, events } = core(sendFn, async (name) => {
      executed.push(name)
      return { content: "ok", isError: false }
    })
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    expect(sent.length).toBe(2)
    // The Bash call of the cut stream never runs, only the final Report.
    expect(executed).toEqual(["Report"])
    const blocks = (sent[1] as Sent).messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    )
    expect(blocks.some((b) => b.type === "tool_use" && b.id === "b1")).toBe(false)
    expect(events.some((e) => e.type === "error")).toBe(false)
  })
})

/** The `turn_started` and `turn_completed` turns, in order. */
function turnEvents(events: AgentEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === "turn_started"
      ? [`start:${e.turn}`]
      : e.type === "turn_completed"
        ? [`done:${e.turn}:${e.stopReason}`]
        : [],
  )
}

describe("AgentCore.run wrap-up: review 2", () => {
  it("MAJ-3: when the final request gives no answer, turn_completed still comes", async () => {
    const sent: Sent[] = []
    const ac = new AbortController()
    const { agent, events } = core(
      transport(sent, async (n, opts) => {
        if (n === 1) {
          setTimeout(() => ac.abort(REASON), 5)
          return await hangUntil(opts.signal)
        }
        throw Object.assign(new Error("bad request"), { errorClass: "permanent" })
      }),
      async () => ({ content: "ok", isError: false }),
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    expect(sent.length).toBe(2)
    expect(turnEvents(events)).toEqual(["start:1", "start:2", "done:2:error"])
    const done = events.find((e) => e.type === "turn_completed")
    expect(done).toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } })
    expect(events.filter((e) => e.type === "run_finished")).toEqual([
      { type: "run_finished", outcome: "truncated" },
    ])
  })

  it("MAJ-3: with no note and a history that ends on the assistant, no request and no turn", async () => {
    const sent: Sent[] = []
    const ac = new AbortController()
    const { agent, events } = core(
      transport(sent, async () => ({
        blocks: [{ type: "text", text: "done" }],
        text: "done",
        stopReason: "end_turn",
      })),
      async () => ({ content: "ok", isError: false }),
      {
        // The turn ended (history ends on the assistant). The wrap-up, with
        // no note, comes while the Stop hook runs.
        lifecycle: {
          beforeTurnStop: async (payload) => {
            ac.abort(WRAP_UP_REASON)
            return { action: "allow", payload }
          },
        },
      },
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    expect(sent.length).toBe(1)
    expect(turnEvents(events)).toEqual(["start:1"])
    expect(events.filter((e) => e.type === "run_finished")).toEqual([
      { type: "run_finished", outcome: "truncated" },
    ])
  })

  it("MAJ-3: an empty final answer gives a balanced turn and no tool run", async () => {
    const sent: Sent[] = []
    const ac = new AbortController()
    const executed: string[] = []
    const { agent, events } = core(
      transport(sent, async (n, opts) => {
        if (n === 1) {
          setTimeout(() => ac.abort(REASON), 5)
          return await hangUntil(opts.signal)
        }
        return { blocks: [], text: "", stopReason: "end_turn" }
      }),
      async (name) => {
        executed.push(name)
        return { content: "ok", isError: false }
      },
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    expect(sent.length).toBe(2)
    expect(executed).toEqual([])
    expect(turnEvents(events)).toEqual(["start:1", "start:2", "done:2:end_turn"])
  })

  it("a wrap-up after the run ended changes nothing", async () => {
    const sent: Sent[] = []
    const ac = new AbortController()
    const { agent, events } = core(
      transport(sent, async () => ({ blocks: [], text: "done", stopReason: "end_turn" })),
      async () => ({ content: "ok", isError: false }),
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))
    ac.abort(REASON)
    await Bun.sleep(5)
    expect(result.outcome).toBe("completed")
    expect(sent.length).toBe(1)
    expect(events.filter((e) => e.type === "run_finished")).toEqual([
      { type: "run_finished", outcome: "completed" },
    ])
  })

  it("MAJ-2: a wrap-up during a recovery compaction sends the final turn", async () => {
    const sent: Sent[] = []
    const ac = new AbortController()
    const { agent, events } = core(
      transport(sent, async (n) => {
        if (n === 1) {
          throw Object.assign(new Error("prompt too long"), {
            errorClass: "recoverable",
            recovery: "compact",
          })
        }
        return reported
      }),
      async () => ({ content: "ok", isError: false }),
    )
    // The compact obeys the signal: SIGTERM comes during its summary call.
    agent.compact = async () => {
      ac.abort(REASON)
      ac.signal.throwIfAborted()
      throw new Error("unreachable")
    }
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    expect(sent.length).toBe(2)
    expect(events.some((e) => e.type === "error")).toBe(false)
    // Not a pause: no `waiting_for_host` status.
    expect(JSON.stringify(events.filter((e) => e.type === "status"))).not.toContain(
      "waiting_for_host",
    )
    expect(events.filter((e) => e.type === "run_finished")).toEqual([
      { type: "run_finished", outcome: "truncated" },
    ])
  })

  it("a WrapUpAbortError before the round request exists is a plain abort", async () => {
    const ac = new AbortController()
    const sent: Sent[] = []
    const { agent, events } = core(
      transport(sent, async () => reported),
      async () => ({ content: "ok", isError: false }),
      {
        mediaResolver: {
          resolveUserContent: async () => {
            ac.abort(REASON)
            throw new WrapUpAbortError()
          },
        },
      },
    )
    const err = await drain(agent.run("go", { signal: ac.signal })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe("AbortError")
    expect(sent.length).toBe(0)
    expect(events.filter((e) => e.type === "error")).toEqual([
      { type: "error", message: "aborted" },
    ])
    expect(events.filter((e) => e.type === "run_finished")).toEqual([
      { type: "run_finished", outcome: "aborted" },
    ])
  })

  it("MIN-2: a cause that is not the wrap-up goes to a diagnostic", async () => {
    const ac = new AbortController()
    const { diagnostics, logs } = recordingDiagnostics()
    const { agent } = core(
      transport([], async () => {
        // SIGTERM comes as the answer ends; then the record step breaks.
        ac.abort(REASON)
        return reported
      }),
      async () => ({ content: "ok", isError: false }),
      {
        diagnostics,
        sessionPersistence: {
          appendUser: () => "id",
          appendAssistant: () => {
            throw new Error("log write failed")
          },
          appendToolResult: () => {},
          appendNote: () => {},
          appendRewind: () => {},
        },
      },
    )
    const result = await drain(agent.run("go", { signal: ac.signal }))
    expect(result.outcome).toBe("truncated")
    const cause = logs.find((l) => l.source === "agent.wrap-up-cause")
    expect(String(cause?.structuredData?.cause)).toContain("log write failed")
  })
})

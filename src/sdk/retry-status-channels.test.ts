/**
 * One retry wait reaches BOTH status channels (spec S23):
 * - the injected `statusPort` gets one `retrying` / `waiting_for_quota` row,
 *   opened before the sleep and cleared after it (the TUI status bus);
 * - the run's event stream gets one `status` event (SDK hosts: print, web, ACP).
 *
 * `AgentCore`'s recovery loop (`run-recovery.waitToRetry`) and the transport
 * retry loop share `waitBeforeRetry`. This test pins that the agent loop
 * passes its construction-time port through, so neither channel goes dark.
 *
 * @module sdk/retry-status-channels.test
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { LiveStatus, StatusFields, StatusPort } from "../bus/status-port.ts"
import type { RetryClock } from "../llm/transport/retry-policy.ts"
import type { StreamedResponse, TransportFn } from "../llm/transport/types.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import type { AgentEvent } from "./events.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

interface Row {
  fields: StatusFields
  openedAt: number
  clearedAt: number | null
}

function recordingPort(clock: { now: () => number }): { port: StatusPort; rows: Row[] } {
  const rows: Row[] = []
  return {
    rows,
    port: {
      open(fields): LiveStatus {
        const row: Row = { fields, openedAt: clock.now(), clearedAt: null }
        rows.push(row)
        return {
          update: () => {},
          updateActivity: () => {},
          clear: () => {
            row.clearedAt = clock.now()
          },
        }
      },
    },
  }
}

function fakeClock(): RetryClock {
  let now = 1_000_000
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  }
}

const ok: StreamedResponse = {
  blocks: [{ type: "text", text: "done" }],
  text: "done",
  stopReason: "end_turn",
}

function failingTimes(failures: number, fail: () => Error): TransportFn {
  let calls = 0
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    calls++
    if (calls <= failures) throw fail()
    yield "done"
    return ok
  }
}

async function drain(gen: AsyncGenerator<string, TurnResult, undefined>): Promise<TurnResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

function run(sendFn: TransportFn, clock: RetryClock, port: StatusPort) {
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
    statusPort: port,
    retry: { clock, random: () => 0.5 },
  })
  return { agent, events }
}

describe("AgentCore retry status reaches both channels", () => {
  it("each transient wait opens one retrying row on the port and emits one status event", async () => {
    const clock = fakeClock()
    const { port, rows } = recordingPort(clock)
    const transient = () => Object.assign(new Error("overloaded"), { errorClass: "transient" })
    const { agent, events } = run(failingTimes(2, transient), clock, port)

    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")

    const retryRows = rows.filter((r) => r.fields.phase === "retrying")
    expect(retryRows).toHaveLength(2)
    expect(retryRows[0]?.fields).toMatchObject({ attempt: 2, cause: "transient" })
    expect(retryRows[1]?.fields).toMatchObject({ attempt: 3 })
    for (const r of retryRows) {
      // Opened before the sleep, cleared after it (the clock moved).
      expect(r.clearedAt).not.toBeNull()
      expect((r.clearedAt ?? 0) - r.openedAt).toBe(r.fields.nextDelayMs ?? -1)
    }

    const statusEvents = events.filter((e) => e.type === "status" && e.phase === "retrying")
    expect(statusEvents).toHaveLength(2)
    expect(statusEvents.map((e) => (e.type === "status" ? e.nextDelayMs : -1))).toEqual(
      retryRows.map((r) => r.fields.nextDelayMs),
    )
  })

  it("a permanent error emits waiting_for_host as an event only, with no port row", async () => {
    // By design: the run is over (outcome `waiting`); the host shows the
    // error, and there is nothing for a live row to spin for.
    const clock = fakeClock()
    const { port, rows } = recordingPort(clock)
    const permanent = () => Object.assign(new Error("bad request"), { errorClass: "permanent" })
    const { agent, events } = run(failingTimes(99, permanent), clock, port)

    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("waiting")
    expect(events.some((e) => e.type === "status" && e.phase === "waiting_for_host")).toBe(true)
    expect(rows.some((r) => r.fields.phase === "waiting_for_host")).toBe(false)
  })
})

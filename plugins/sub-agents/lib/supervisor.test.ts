import { describe, expect, it } from "bun:test"

import { type Effect, supervisorTick, type WorkerProbe } from "./supervisor.ts"
import {
  type Progress,
  type ResultDigest,
  sessionId,
  type SubagentRecord,
  type SubagentStatus,
  subagentId,
} from "./types.ts"

const NOW = "2026-05-30T12:00:00.000Z"
const NOW_MS = Date.parse(NOW)
const PROG: Progress = { tools: 4, tokens: 1200, lastTool: "Grep" }
const RESULT: ResultDigest = { short: "found 3 callers", tokens: 5000, tools: 12 }

function rec(id: string, status: SubagentStatus, budgetSec?: number): SubagentRecord {
  return {
    id: subagentId(id),
    sid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
    label: "explorer",
    type: "explorer",
    model: "claude-haiku-4-5",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: NOW,
    status,
    depth: 1,
    leadSid: sessionId("11111111-1111-4111-8111-111111111111"),
    ...(budgetSec ? { budget: { deadlineSec: budgetSec } } : {}),
  }
}

function running(startedAt = NOW): SubagentStatus {
  return { kind: "running", pid: 4242, startedAt, progress: { tools: 0, tokens: 0 } }
}

function tick(records: SubagentRecord[], probes: Record<string, WorkerProbe>, nowMs = NOW_MS) {
  return supervisorTick({ records, probes: new Map(Object.entries(probes)), now: NOW, nowMs })
}

describe("supervisorTick — running transitions", () => {
  it("refreshes progress while alive (no effects)", () => {
    const out = tick([rec("A1", running())], { A1: { alive: true, progress: PROG } })
    expect(out.changed).toBe(true)
    expect(out.effects).toEqual([])
    const st = out.records[0]?.status
    expect(st?.kind === "running" && st.progress).toEqual(PROG)
  })

  it("leaves a running worker untouched when there is no probe", () => {
    const r = rec("A1", running())
    const out = tick([r], {})
    expect(out.changed).toBe(false)
    expect(out.records[0]).toBe(r) // same reference, no churn
  })

  it("transitions running → done with a result and emits report + inject", () => {
    const out = tick([rec("A1", running())], { A1: { alive: false, exitCode: 0, result: RESULT } })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("done")
    if (st?.kind === "done") expect(st.result).toEqual(RESULT)
    const kinds = out.effects.map((e: Effect) => e.type)
    expect(kinds).toEqual(["emit", "emit", "inject"])
    const inject = out.effects.find((e) => e.type === "inject")
    expect(inject?.type === "inject" && inject.text).toContain("AgentResult A1")
    expect(inject?.type === "inject" && inject.source).toBe("subagent:A1")
  })

  it("transitions running → failed on non-zero exit without a result", () => {
    const out = tick([rec("A1", running())], { A1: { alive: false, exitCode: 1 } })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("failed")
    if (st?.kind === "failed") expect(st.exitCode).toBe(1)
  })

  it("transitions running → done (placeholder) on clean exit with no parsed result", () => {
    const out = tick([rec("A1", running())], { A1: { alive: false, exitCode: 0 } })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("done")
    if (st?.kind === "done") expect(st.result.short).toMatch(/no summary/i)
  })
})

describe("supervisorTick — tasks linkage", () => {
  it("emits subagent.taskUpdate(done) when a linked worker finishes cleanly", () => {
    const r = { ...rec("A1", running()), taskId: "a7b3c4" }
    const out = tick([r], { A1: { alive: false, exitCode: 0, result: RESULT } })
    const update = out.effects.find((e) => e.type === "emit" && e.channel === "subagent.taskUpdate")
    expect(update).toBeDefined()
    if (update?.type === "emit") {
      expect(update.payload).toMatchObject({ taskId: "a7b3c4", status: "done", bySubagent: "A1" })
    }
  })

  it("emits subagent.taskUpdate(canceled) with a reason when a linked worker fails", () => {
    const r = { ...rec("A1", running()), taskId: "a7b3c4" }
    const out = tick([r], { A1: { alive: false, exitCode: 1 } })
    const update = out.effects.find((e) => e.type === "emit" && e.channel === "subagent.taskUpdate")
    expect(update?.type === "emit" && update.payload).toMatchObject({ taskId: "a7b3c4", status: "canceled" })
  })

  it("emits NO taskUpdate for an unlinked worker", () => {
    const out = tick([rec("A1", running())], { A1: { alive: false, exitCode: 0, result: RESULT } })
    expect(out.effects.some((e) => e.type === "emit" && e.channel === "subagent.taskUpdate")).toBe(false)
  })
})

describe("supervisorTick — budget", () => {
  it("trips a deadline: emits a stop effect and marks failed(timeout)", () => {
    const started = new Date(NOW_MS - 120_000).toISOString() // 2 min ago
    const out = tick([rec("A1", running(started), 60)], { A1: { alive: true, progress: PROG } })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("failed")
    if (st?.kind === "failed") expect(st.error).toMatch(/timed out/i)
    const stop = out.effects.find((e) => e.type === "stop")
    expect(stop?.type === "stop" && stop.pid).toBe(4242)
  })

  it("does not trip before the deadline", () => {
    const started = new Date(NOW_MS - 30_000).toISOString() // 30s ago, budget 60s
    const out = tick([rec("A1", running(started), 60)], { A1: { alive: true } })
    expect(out.records[0]?.status.kind).toBe("running")
  })
})

describe("supervisorTick — queued + terminal", () => {
  it("fails a queued worker whose process is already gone (launch failed)", () => {
    const out = tick([rec("A1", { kind: "queued" })], { A1: { alive: false, exitCode: 127 } })
    expect(out.records[0]?.status.kind).toBe("failed")
  })

  it("never re-touches a terminal worker (digest injected exactly once)", () => {
    const done: SubagentStatus = { kind: "done", endedAt: NOW, result: RESULT }
    const out = tick([rec("A1", done)], { A1: { alive: false, result: RESULT } })
    expect(out.changed).toBe(false)
    expect(out.effects).toEqual([])
  })
})

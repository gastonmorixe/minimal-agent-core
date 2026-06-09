import { describe, expect, it } from "bun:test"

import {
  err,
  fleetStats,
  isActive,
  isTerminal,
  ok,
  type Progress,
  type SubagentRecord,
  type SubagentStatus,
  sessionId,
  subagentId,
} from "./types.ts"

const PROG: Progress = { tools: 3, tokens: 1000, lastTool: "Grep" }

function rec(id: string, status: SubagentStatus): SubagentRecord {
  return {
    id: subagentId(id),
    sid: sessionId(`00000000-0000-4000-8000-0000000000${id.slice(-2).padStart(2, "0")}`),
    label: id,
    type: "worker",
    model: "claude-haiku-4-5",
    task: "do a thing",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: "2026-05-30T00:00:00.000Z",
    status,
    depth: 1,
    leadSid: sessionId("11111111-1111-4111-8111-111111111111"),
  }
}

describe("Result", () => {
  it("ok / err construct the tagged shape", () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 })
    expect(err("boom")).toEqual({ ok: false, error: "boom" })
  })
})

describe("isTerminal / isActive", () => {
  it("queued and running are active, the rest terminal", () => {
    expect(isActive({ kind: "queued" })).toBe(true)
    expect(isActive({ kind: "running", pid: 1, startedAt: "t", progress: PROG })).toBe(true)
    expect(
      isTerminal({ kind: "done", endedAt: "t", result: { short: "", tokens: 0, tools: 0 } }),
    ).toBe(true)
    expect(isTerminal({ kind: "failed", endedAt: "t", error: "x" })).toBe(true)
    expect(isTerminal({ kind: "stopped", endedAt: "t" })).toBe(true)
  })
})

describe("fleetStats", () => {
  it("tallies per-kind counts and sums tokens (running progress + done result + incomplete)", () => {
    const records: SubagentRecord[] = [
      rec("A1", { kind: "queued" }),
      rec("A2", { kind: "running", pid: 10, startedAt: "t", progress: { tools: 5, tokens: 2000 } }),
      rec("A3", { kind: "running", pid: 11, startedAt: "t", progress: { tools: 1, tokens: 500 } }),
      rec("A4", { kind: "done", endedAt: "t", result: { short: "ok", tokens: 3000, tools: 9 } }),
      rec("A5", { kind: "failed", endedAt: "t", error: "crash" }),
      rec("A6", { kind: "stopped", endedAt: "t", reason: "superseded" }),
      rec("A7", { kind: "incomplete", endedAt: "t", reason: "no sentinel", tokens: 700, tools: 4 }),
    ]
    const s = fleetStats(records)
    expect(s).toEqual({
      total: 7,
      queued: 1,
      running: 2,
      done: 1,
      incomplete: 1,
      failed: 1,
      stopped: 1,
      tokens: 2000 + 500 + 3000 + 700,
    })
  })

  it("is empty-safe", () => {
    expect(fleetStats([])).toEqual({
      total: 0,
      queued: 0,
      running: 0,
      done: 0,
      incomplete: 0,
      failed: 0,
      stopped: 0,
      tokens: 0,
    })
  })
})

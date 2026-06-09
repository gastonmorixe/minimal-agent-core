import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  buildPresenceRows,
  liveness,
  mergeLatest,
  type PresenceRow,
  parseRows,
  readMesh,
  serializeRows,
  writeLeadPresence,
} from "./presence.ts"
import { type SubagentRecord, type SubagentStatus, sessionId, subagentId } from "./types.ts"

const NOW = "2026-05-30T12:00:00.000Z"
const NOW_MS = Date.parse(NOW)

function rec(id: string, status: SubagentStatus): SubagentRecord {
  return {
    id: subagentId(id),
    sid: sessionId(`00000000-0000-4000-8000-0000000000${id.slice(-2).padStart(2, "0")}`),
    label: "worker",
    type: "worker",
    model: "claude-haiku-4-5",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: NOW,
    status,
    depth: 1,
    leadSid: sessionId("lead"),
  }
}

describe("buildPresenceRows", () => {
  it("emits a lead row + one row per worker with mapped status", () => {
    const rows = buildPresenceRows(
      { sid: "lead-1", pid: 100, model: "claude-opus-4-8", cwd: "/repo" },
      [
        rec("A1", { kind: "running", pid: 200, startedAt: NOW, progress: { tools: 0, tokens: 0 } }),
        rec("A2", { kind: "done", endedAt: NOW, result: { short: "x", tokens: 1, tools: 1 } }),
      ],
      NOW,
    )
    expect(rows[0]).toMatchObject({ sid: "lead-1", role: "lead", status: "active", pid: 100 })
    expect(rows[1]).toMatchObject({ role: "worker", status: "active", pid: 200, leadSid: "lead-1" })
    expect(rows[2]).toMatchObject({ role: "worker", status: "done", pid: 0 })
  })
})

describe("parse / serialize / mergeLatest", () => {
  it("round-trips and keeps the latest row per sid", () => {
    const a: PresenceRow = {
      sid: "x",
      role: "worker",
      status: "active",
      pid: 1,
      ts: "2026-05-30T12:00:00.000Z",
    }
    const b: PresenceRow = {
      sid: "x",
      role: "worker",
      status: "done",
      pid: 0,
      ts: "2026-05-30T12:05:00.000Z",
    }
    const parsed = parseRows(serializeRows([a, b]))
    expect(parsed).toHaveLength(2)
    const merged = mergeLatest(parsed)
    expect(merged.get("x")?.status).toBe("done") // latest ts wins
  })
})

describe("liveness", () => {
  it("active + fresh + pid alive → live", () => {
    const row: PresenceRow = { sid: "x", role: "worker", status: "active", pid: 7, ts: NOW }
    expect(liveness(row, NOW_MS, () => true)).toMatchObject({ status: "live", pid: 7 })
  })
  it("active + fresh + pid gone → dead", () => {
    const row: PresenceRow = { sid: "x", role: "worker", status: "active", pid: 7, ts: NOW }
    expect(liveness(row, NOW_MS, () => false)).toMatchObject({ status: "dead" })
  })
  it("terminal row → dead", () => {
    const row: PresenceRow = { sid: "x", role: "worker", status: "failed", pid: 0, ts: NOW }
    expect(liveness(row, NOW_MS).status).toBe("dead")
  })
  it("stale active row → unknown", () => {
    const row: PresenceRow = { sid: "x", role: "worker", status: "active", pid: 7, ts: NOW }
    expect(liveness(row, NOW_MS + 60_000).status).toBe("unknown") // 60s old > STALE_MS
  })
  it("no row → unknown", () => {
    expect(liveness(undefined, NOW_MS).status).toBe("unknown")
  })
})

describe("write + read mesh (per-lead files merged)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "presence-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("merges rows across multiple leads' files", () => {
    writeLeadPresence(
      dir,
      "lead-1",
      buildPresenceRows(
        { sid: "lead-1", pid: 1 },
        [rec("A1", { kind: "running", pid: 9, startedAt: NOW, progress: { tools: 0, tokens: 0 } })],
        NOW,
      ),
    )
    writeLeadPresence(dir, "lead-2", buildPresenceRows({ sid: "lead-2", pid: 2 }, [], NOW))
    const mesh = readMesh(dir)
    expect(mesh.get("lead-1")?.role).toBe("lead")
    expect(mesh.get("lead-2")?.role).toBe("lead")
    expect([...mesh.values()].filter((r) => r.role === "worker")).toHaveLength(1)
  })

  it("readMesh is empty-safe", () => {
    expect(readMesh(join(dir, "nope")).size).toBe(0)
  })
})

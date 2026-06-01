import { describe, expect, it } from "bun:test"

import {
  renderFleetDisplay,
  renderResultDisplay,
  renderSpawnDisplay,
  renderStopDisplay,
  shortModel,
} from "./render.ts"
import {
  type ResultDigest,
  sessionId,
  type SubagentRecord,
  type SubagentStatus,
  subagentId,
} from "./types.ts"

const NOW = Date.parse("2026-05-30T12:00:00.000Z")
const RESULT: ResultDigest = { short: "2 critical, 3 warnings", tokens: 5200, tools: 18, artifacts: ["a/RESULT.md"] }

function rec(id: string, label: string, status: SubagentStatus, model = "claude-sonnet-4-6"): SubagentRecord {
  return {
    id: subagentId(id),
    sid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
    label,
    type: label,
    model,
    task: "refactor src/parser.ts into smaller units",
    isolation: "fork",
    workspace: "inherit-cwd",
    spawnedAt: "2026-05-30T11:58:00.000Z",
    status,
    depth: 1,
    leadSid: sessionId("11111111-1111-4111-8111-111111111111"),
  }
}

describe("shortModel", () => {
  it("maps full ids to tier words", () => {
    expect(shortModel("claude-sonnet-4-6")).toBe("sonnet")
    expect(shortModel("claude-opus-4-8[1m]")).toBe("opus")
    expect(shortModel("claude-haiku-4-5")).toBe("haiku")
    expect(shortModel("some-other")).toBe("some-other")
  })
})

describe("renderSpawnDisplay", () => {
  it("shows id · type · model · isolation and a background handle footer", () => {
    const r = rec("A2", "worker", { kind: "running", pid: 48213, startedAt: "t", progress: { tools: 0, tokens: 0 } })
    const d = renderSpawnDisplay(r, false)
    expect(d.header).toBe("↗ A2 · worker · sonnet · fork")
    expect(d.body).toContain("refactor src/parser.ts")
    expect(d.footer).toContain("running in background")
    expect(d.footer).toContain("pid 48213")
    expect(d.footer).toContain("session 9c1a4f…")
  })
})

describe("renderFleetDisplay", () => {
  it("renders a row per worker + a summary footer", () => {
    const records = [
      rec("A1", "reviewer", { kind: "done", endedAt: "t", result: RESULT }),
      rec("A2", "worker", { kind: "running", pid: 1, startedAt: "2026-05-30T11:58:38.000Z", progress: { tools: 14, tokens: 9100, lastTool: "Edit" } }),
    ]
    const d = renderFleetDisplay(records, false, NOW)
    expect(d.header).toContain("1 running")
    expect(d.header).toContain("1 done")
    const rows = d.body.split("\n")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain("A1")
    expect(rows[0]).toContain("AgentResult A1")
    expect(rows[1]).toContain("A2")
    expect(d.footer).toContain("1 running")
    expect(d.footer).toContain("0 failed")
  })

  it("renders a hint for an empty fleet", () => {
    const d = renderFleetDisplay([], false, NOW)
    expect(d.header).toContain("no sub-agents")
    expect(d.body).toContain("SpawnAgent")
  })
})

describe("renderResultDisplay", () => {
  it("shows the distilled result + artifacts + token/tool footer", () => {
    const r = rec("A1", "reviewer", { kind: "done", endedAt: "t", result: RESULT })
    const d = renderResultDisplay(r, false)
    expect(d.header).toContain("↘ A1")
    expect(d.header).toContain("done")
    expect(d.body).toContain("2 critical, 3 warnings")
    expect(d.body).toContain("artifacts: a/RESULT.md")
    expect(d.footer).toContain("5.2k tok")
    expect(d.footer).toContain("18 tools")
  })

  it("reports honestly when the worker is not done", () => {
    const r = rec("A2", "worker", { kind: "running", pid: 1, startedAt: "t", progress: { tools: 0, tokens: 0 } })
    const d = renderResultDisplay(r, false)
    expect(d.body).toContain("is running")
  })
})

describe("renderStopDisplay", () => {
  it("renders the stopped handle with an optional reason", () => {
    const r = rec("A3", "explorer", { kind: "stopped", endedAt: "t", reason: "superseded by A5" })
    const d = renderStopDisplay(r, false)
    expect(d.header).toContain("✘ A3")
    expect(d.footer).toContain("stopped")
    expect(d.footer).toContain("superseded by A5")
  })
})

describe("ansi rendering", () => {
  it("emits color codes when ansi=true", () => {
    const r = rec("A2", "worker", { kind: "running", pid: 1, startedAt: "t", progress: { tools: 0, tokens: 0 } })
    expect(renderSpawnDisplay(r, true).header).toContain("\x1b[")
  })
})

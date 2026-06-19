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
  type SubagentRecord,
  type SubagentStatus,
  sessionId,
  subagentId,
} from "./types.ts"

const NOW = Date.parse("2026-05-30T12:00:00.000Z")
const RESULT: ResultDigest = {
  short: "2 critical, 3 warnings",
  tokens: 5200,
  tools: 18,
  artifacts: ["a/RESULT.md"],
}

function rec(
  id: string,
  label: string,
  status: SubagentStatus,
  model = "claude-sonnet-4-6",
): SubagentRecord {
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
  function spawned(label: string, task: string): SubagentRecord {
    return {
      id: subagentId("A9"),
      sid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
      label,
      type: label,
      model: "claude-sonnet-4-6",
      task,
      isolation: "fork",
      workspace: "inherit-cwd",
      spawnedAt: "2026-05-30T11:58:00.000Z",
      status: {
        kind: "running",
        pid: 48213,
        startedAt: "t",
        progress: { tools: 0, tokens: 0 },
      },
      depth: 1,
      leadSid: sessionId("11111111-1111-4111-8111-111111111111"),
    }
  }

  it("shows id · type · model · isolation and a background handle footer", () => {
    const r = rec("A2", "worker", {
      kind: "running",
      pid: 48213,
      startedAt: "t",
      progress: { tools: 0, tokens: 0 },
    })
    const d = renderSpawnDisplay(r, false)
    expect(d.header).toBe("↗ A2 · worker · sonnet · fork")
    expect(d.body).toContain("refactor src/parser.ts")
    expect(d.footer).toContain("running in background")
    expect(d.footer).toContain("pid 48213")
    expect(d.footer).toContain("session 9c1a4f…")
  })

  it("preserves paragraph structure in the task body", () => {
    const r = spawned("worker", "line one\n\nline two\nline three")
    const d = renderSpawnDisplay(r, false)
    const lines = d.body.split("\n")
    expect(lines).toEqual(["line one", "", "line two", "line three"])
  })

  it("collapses intra-line whitespace but preserves newlines", () => {
    const r = spawned("worker", "first   line\n\nsecond\t\tline  with   spaces")
    const d = renderSpawnDisplay(r, false)
    const lines = d.body.split("\n")
    expect(lines).toEqual(["first line", "", "second line with spaces"])
  })

  it("drops leading and trailing blank lines", () => {
    const r = spawned("worker", "\n\n\na single line\n\n\n")
    const d = renderSpawnDisplay(r, false)
    expect(d.body).toBe("a single line")
  })

  it("caps body at 20 display lines with an elision marker", () => {
    const many = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n")
    const r = spawned("worker", many)
    const d = renderSpawnDisplay(r, false)
    const lines = d.body.split("\n")
    expect(lines).toHaveLength(21) // 20 visible + 1 elision marker
    expect(lines[0]).toBe("line 0")
    expect(lines[19]).toBe("line 19")
    expect(lines[20]).toBe("… +5 more lines")
  })

  it("includes blank lines in the line count for the cap", () => {
    // 23 pairs of ("line N", "") + 3 final lines, no leading/trailing blanks
    // → 23*2 + 3 = 49 total → elides 29
    const pairs: string[] = []
    for (let i = 0; i < 23; i++) {
      pairs.push(`line ${i}`, "")
    }
    pairs.push("line a", "line b", "line c")
    const task = pairs.join("\n")
    const r = spawned("worker", task)
    const d = renderSpawnDisplay(r, false)
    const lines = d.body.split("\n")
    expect(lines).toHaveLength(21) // 20 visible + marker
    expect(lines[20]).toBe("… +29 more lines")
  })

  it("passes through when exactly at the line cap", () => {
    const exact = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")
    const r = spawned("worker", exact)
    const d = renderSpawnDisplay(r, false)
    const lines = d.body.split("\n")
    expect(lines).toHaveLength(20)
    expect(lines[19]).toBe("line 19")
  })
})

describe("renderFleetDisplay", () => {
  it("renders a row per worker + a summary footer", () => {
    const records = [
      rec("A1", "reviewer", { kind: "done", endedAt: "t", result: RESULT }),
      rec("A2", "worker", {
        kind: "running",
        pid: 1,
        startedAt: "2026-05-30T11:58:38.000Z",
        progress: { tools: 14, tokens: 9100, lastTool: "Edit" },
      }),
    ]
    const d = renderFleetDisplay(records, false, NOW)
    expect(d.header).toContain("1 running")
    expect(d.header).toContain("1 done")
    const rows = d.body.split("\n")
    // 2 worker rows + a trailing blank spacer row (so the host paints a `│`
    // line between the last worker and the `╰` footer).
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain("A1")
    expect(rows[0]).toContain("AgentResult A1")
    expect(rows[1]).toContain("A2")
    expect(rows[2]).toBe("")
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
    const r = rec("A2", "worker", {
      kind: "running",
      pid: 1,
      startedAt: "t",
      progress: { tools: 0, tokens: 0 },
    })
    const d = renderResultDisplay(r, false)
    expect(d.body).toContain("is running")
  })

  it("surfaces INCOMPLETE loudly as a terminal no-deliverable state (FIX 7)", () => {
    const r = rec("A3", "log-miner", {
      kind: "incomplete",
      endedAt: "t",
      reason: "exited without a result sentinel or any final message",
      tokens: 4200,
      tools: 9,
    })
    const d = renderResultDisplay(r, false)
    expect(d.header).toContain("incomplete")
    expect(d.body).toContain("NO DELIVERABLE")
    expect(d.body).toContain("Not a success")
    expect(d.footer).toContain("4.2k tok")
  })

  it("renders SALVAGED findings in the body when a contract-miss worker still produced a summary (FIX 5)", () => {
    const r = rec("A3", "log-miner", {
      kind: "incomplete",
      endedAt: "t",
      reason: "missing 1/1 required artifact(s): /findings.md",
      tokens: 58_500,
      tools: 63,
      salvage:
        "AVFragmentedAsset/AVFragmentedAssetMinder is the right Apple API for a growing single fMP4.",
      artifacts: ["/findings.md"],
    })
    const d = renderResultDisplay(r, false)
    expect(d.header).toContain("incomplete")
    // The recovered synthesis is shown, not just a "no deliverable" stub.
    expect(d.body).toContain("AVFragmentedAsset")
    expect(d.body).toContain("FILE MISSING")
    expect(d.body).toContain("salvaged")
  })
})

describe("renderFleetDisplay — incomplete", () => {
  it("counts incomplete in the header + footer and renders a gold no-deliverable row", () => {
    const recs = [
      rec("A1", "explorer", { kind: "done", endedAt: "t", result: RESULT }),
      rec("A2", "log-miner", {
        kind: "incomplete",
        endedAt: "t",
        reason: "no sentinel",
        tokens: 100,
        tools: 2,
      }),
    ]
    const d = renderFleetDisplay(recs, false, NOW)
    expect(d.header).toContain("1 incomplete")
    expect(d.footer).toContain("1 incomplete")
    expect(d.body).toContain("no deliverable")
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
    const r = rec("A2", "worker", {
      kind: "running",
      pid: 1,
      startedAt: "t",
      progress: { tools: 0, tokens: 0 },
    })
    expect(renderSpawnDisplay(r, true).header).toContain("\x1b[")
  })
})

import { describe, expect, it } from "bun:test"

import { fmtElapsed, fmtTokens } from "./style.ts"
import {
  type Progress,
  type ResultDigest,
  type SubagentRecord,
  type SubagentStatus,
  sessionId,
  subagentId,
} from "./types.ts"
import { renderWidget } from "./widget.ts"

const LEAD = "3f2a1111-2222-4333-8444-555566667777"
const NOW = Date.parse("2026-05-30T12:00:00.000Z")

function rec(id: string, label: string, status: SubagentStatus): SubagentRecord {
  return {
    id: subagentId(id),
    sid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
    label,
    type: label,
    model: "claude-haiku-4-5",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: "2026-05-30T11:58:00.000Z",
    status,
    depth: 1,
    leadSid: sessionId(LEAD),
  }
}
function running(progress: Progress, startedAt = "2026-05-30T11:58:38.000Z"): SubagentStatus {
  return { kind: "running", pid: 1, startedAt, progress }
}
const RESULT: ResultDigest = { short: "2 crit, 3 warn", tokens: 5200, tools: 18 }

describe("style formatters", () => {
  it("fmtTokens", () => {
    expect(fmtTokens(950)).toBe("950")
    expect(fmtTokens(9100)).toBe("9.1k")
    expect(fmtTokens(47_900)).toBe("47.9k")
    expect(fmtTokens(612_000)).toBe("612k")
  })
  it("fmtElapsed", () => {
    expect(fmtElapsed(500)).toBe("")
    expect(fmtElapsed(31_000)).toBe("0m31")
    expect(fmtElapsed(82_000)).toBe("1m22")
    expect(fmtElapsed(3_900_000)).toBe("1h05")
  })
})

describe("renderWidget", () => {
  it("collapses to null when no worker is active", () => {
    expect(renderWidget([], { ansi: false, tick: 0, nowMs: NOW, leadSid: LEAD })).toBeNull()
    const allDone = [rec("A1", "reviewer", { kind: "done", endedAt: "t", result: RESULT })]
    expect(renderWidget(allDone, { ansi: false, tick: 0, nowMs: NOW, leadSid: LEAD })).toBeNull()
  })

  it("renders a header + one row per worker when active", () => {
    const records = [
      rec("A1", "reviewer", { kind: "done", endedAt: "t", result: RESULT }),
      rec(
        "A2",
        "worker",
        running({ tools: 14, tokens: 9100, lastActivity: "editing src/parser.ts" }),
      ),
      rec(
        "A3",
        "explorer",
        running({ tools: 6, tokens: 2000, lastActivity: "grep callers of fork()" }),
      ),
    ]
    const out = renderWidget(records, { ansi: false, tick: 0, nowMs: NOW, leadSid: LEAD })
    expect(out).not.toBeNull()
    const lines = (out as string).split("\n")
    expect(lines[0]).toContain("◈ fleet 3f2a")
    expect(lines[0]).toContain("◐ 2") // 2 running
    expect(lines[0]).toContain("✔ 1") // 1 done
    expect(lines).toHaveLength(4) // header + 3 rows
    // running rows are ranked before the done row
    expect(lines[1]).toContain("A2")
    expect(lines[1]).toContain("editing src/parser.ts")
    expect(lines[3]).toContain("AgentResult A1") // done row points at the result
  })

  it("shows the incomplete count in the header and a ⚠ no-deliverable row (FIX 7)", () => {
    const records = [
      rec("A1", "worker", running({ tools: 2, tokens: 500 })),
      rec("A2", "log-miner", {
        kind: "incomplete",
        endedAt: "t",
        reason: "no sentinel",
        tokens: 700,
        tools: 4,
      }),
    ]
    const out = renderWidget(records, { ansi: false, tick: 0, nowMs: NOW, leadSid: LEAD }) as string
    expect(out).not.toBeNull()
    const lines = out.split("\n")
    expect(lines[0]).toContain("⚠ 1") // incomplete count in the header
    expect(out).toContain("no deliverable")
  })

  it("breathes: the running glyph cycles with tick", () => {
    const records = [rec("A2", "worker", running({ tools: 1, tokens: 100 }))]
    const at = (t: number) =>
      (renderWidget(records, { ansi: false, tick: t, nowMs: NOW, leadSid: LEAD }) as string).split(
        "\n",
      )[1]
    // tick 0 → ◐, tick 1 → ◓ (distinct frames)
    expect(at(0)).not.toBe(at(1))
  })

  it("caps rows and shows a +N more overflow line", () => {
    const records = Array.from({ length: 9 }, (_, i) =>
      rec(`A${i + 1}`, "worker", running({ tools: 1, tokens: 100 })),
    )
    const out = renderWidget(records, {
      ansi: false,
      tick: 0,
      nowMs: NOW,
      leadSid: LEAD,
      maxRows: 4,
    })
    const lines = (out as string).split("\n")
    expect(lines).toHaveLength(1 + 4 + 1) // header + 4 rows + overflow
    expect(lines.at(-1)).toContain("+5 more")
  })

  it("paints the token total over budget (GOLD) via ansi codes", () => {
    const records = [rec("A2", "worker", running({ tools: 1, tokens: 90_000 }))]
    const out = renderWidget(records, {
      ansi: true,
      tick: 0,
      nowMs: NOW,
      leadSid: LEAD,
      tokenBudget: 50_000,
    }) as string
    expect(out).toContain("\x1b[38;5;214m") // GOLD applied to the over-budget total
  })
})

/**
 * Tests for the model-facing `content` text — focused on `resultText`, the
 * payload `AgentResult` returns to the LEAD. The critical case is FIX 5: an
 * `incomplete` worker that nonetheless SALVAGED findings must surface those
 * findings (not just "NO DELIVERABLE"), so the lead can act without mining the
 * worker's raw transcript (the A2/A3 data-loss bug).
 *
 * @module sub-agents/lib/content.test
 */

import { describe, expect, it } from "bun:test"

import { resultText } from "./content.ts"
import { type SubagentRecord, type SubagentStatus, sessionId, subagentId } from "./types.ts"

function rec(status: SubagentStatus): SubagentRecord {
  return {
    id: subagentId("A2"),
    sid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
    label: "log-miner",
    type: "log-miner",
    model: "claude-opus-4-8",
    task: "research the AVKit ceiling and write /tmp/RESEARCH_AVKIT.md",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: "2026-05-30T11:58:00.000Z",
    status,
    depth: 1,
    leadSid: sessionId("11111111-1111-4111-8111-111111111111"),
  }
}

describe("resultText — incomplete with salvage (FIX 5)", () => {
  it("surfaces the salvaged findings instead of discarding them", () => {
    const text = resultText(
      rec({
        kind: "incomplete",
        endedAt: "t",
        reason: "missing 1/1 required artifact(s): /tmp/RESEARCH_AVKIT.md",
        tokens: 58_500,
        tools: 63,
        salvage:
          "AVFragmentedAsset + AVFragmentedAssetMinder is the correct Apple API for a growing single fMP4.",
        artifacts: ["/tmp/RESEARCH_AVKIT.md"],
      }),
    )
    // The actual research crosses back to the lead.
    expect(text).toContain("AVFragmentedAsset")
    expect(text).toContain("salvaged findings")
    // It is still honestly flagged as not-a-clean-success and names the missing file.
    expect(text).toMatch(/INCOMPLETE|does NOT exist/i)
    expect(text).toContain("/tmp/RESEARCH_AVKIT.md")
    // The claimed-but-absent artifact is flagged for verification.
    expect(text).toMatch(/claimed artifacts/i)
  })

  it("falls back to the bare no-deliverable message when nothing was salvaged", () => {
    const text = resultText(
      rec({
        kind: "incomplete",
        endedAt: "t",
        reason: "exited without a result sentinel or any final message",
        tokens: 1200,
        tools: 4,
      }),
    )
    expect(text).toContain("WITHOUT a deliverable")
    expect(text).not.toContain("salvaged findings")
  })
})

describe("resultText — done still carries its result", () => {
  it("prints the short synthesis and token/tool counts", () => {
    const text = resultText(
      rec({
        kind: "done",
        endedAt: "t",
        result: { short: "found 3 callers", tokens: 5000, tools: 12 },
      }),
    )
    expect(text).toContain("found 3 callers")
    expect(text).toContain("12 tool calls")
  })
})

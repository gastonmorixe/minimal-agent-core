import { describe, expect, test } from "bun:test"

import {
  type Finding as LegacyFinding,
  type FindingSeverity as LegacyFindingSeverity,
  type ToolDidInvokePayload as LegacyToolDidInvokePayload,
  type ToolDidInvokeSeed as LegacyToolDidInvokeSeed,
  addFinding as legacyAddFinding,
  addNote as legacyAddNote,
  makeToolDidInvokePayload as legacyMakeToolDidInvokePayload,
} from "../plugins/hooks/tool-lifecycle.ts"

import {
  addFinding,
  addNote,
  type Finding,
  type FindingSeverity,
  makeToolDidInvokePayload,
  type ToolDidInvokePayload,
  type ToolDidInvokeSeed,
} from "./tool-lifecycle.ts"

function assertBidirectionalTypeCompatibility(
  canonical: {
    severity: FindingSeverity
    finding: Finding
    payload: ToolDidInvokePayload
    seed: ToolDidInvokeSeed
  },
  legacy: {
    severity: LegacyFindingSeverity
    finding: LegacyFinding
    payload: LegacyToolDidInvokePayload
    seed: LegacyToolDidInvokeSeed
  },
): void {
  const legacySeverity: LegacyFindingSeverity = canonical.severity
  const canonicalSeverity: FindingSeverity = legacy.severity
  const legacyFinding: LegacyFinding = canonical.finding
  const canonicalFinding: Finding = legacy.finding
  const legacyPayload: LegacyToolDidInvokePayload = canonical.payload
  const canonicalPayload: ToolDidInvokePayload = legacy.payload
  const legacySeed: LegacyToolDidInvokeSeed = canonical.seed
  const canonicalSeed: ToolDidInvokeSeed = legacy.seed

  void [
    legacySeverity,
    canonicalSeverity,
    legacyFinding,
    canonicalFinding,
    legacyPayload,
    canonicalPayload,
    legacySeed,
    canonicalSeed,
  ]
}

void assertBidirectionalTypeCompatibility

describe("SDK tool lifecycle", () => {
  test("canonical constructor preserves facts and owns fresh empty accumulators", () => {
    const input = { file_path: "/repo/a.ts" }
    const first = makeToolDidInvokePayload({
      tool: "Edit",
      input,
      cwd: "/repo",
      ok: true,
      filePath: "/repo/a.ts",
    })
    const second = makeToolDidInvokePayload({ tool: "Bash", input: {}, cwd: "/repo", ok: false })

    expect(first).toEqual({
      tool: "Edit",
      input,
      cwd: "/repo",
      ok: true,
      filePath: "/repo/a.ts",
      findings: [],
      notes: [],
    })
    expect(second).toEqual({
      tool: "Bash",
      input: {},
      cwd: "/repo",
      ok: false,
      findings: [],
      notes: [],
    })
    expect(first.findings).not.toBe(second.findings)
    expect(first.notes).not.toBe(second.notes)
  })

  test("legacy plugin path re-exports canonical runtime functions by identity", () => {
    expect(legacyMakeToolDidInvokePayload).toBe(makeToolDidInvokePayload)
    expect(legacyAddFinding).toBe(addFinding)
    expect(legacyAddNote).toBe(addNote)
  })
})

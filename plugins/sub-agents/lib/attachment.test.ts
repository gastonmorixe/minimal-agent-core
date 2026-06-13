import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { SubagentsAttachment } from "./attachment.ts"
import { SubagentStore } from "./store.ts"
import { type SubagentRecord, type SubagentStatus, sessionId, subagentId } from "./types.ts"

const NOW = Date.parse("2026-05-30T12:00:00.000Z")

function rec(id: string, status: SubagentStatus): SubagentRecord {
  return {
    id: subagentId(id),
    sid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
    label: "worker",
    type: "worker",
    model: "claude-haiku-4-5",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: "2026-05-30T11:59:00.000Z",
    status,
    depth: 1,
    leadSid: sessionId("11111111-1111-4111-8111-111111111111"),
  }
}

describe("SubagentsAttachment", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-att-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("returns null when there is no session id", () => {
    expect(new SubagentsAttachment(null, { dir }).toAttachment()).toBeNull()
    expect(new SubagentsAttachment("  ", { dir }).toAttachment()).toBeNull()
  })

  it("returns null when no worker is active (idle session pays no tokens)", () => {
    const store = new SubagentStore("lead", { dir })
    store.upsert(
      rec("A1", { kind: "done", endedAt: "t", result: { short: "x", tokens: 1, tools: 1 } }),
    )
    expect(new SubagentsAttachment("lead", { dir }).toAttachment()).toBeNull()
  })

  it("emits a bounded <ma::agent::subagents> block when workers are active", () => {
    const store = new SubagentStore("lead", { dir })
    store.upsert(
      rec("A1", { kind: "done", endedAt: "t", result: { short: "x", tokens: 5000, tools: 9 } }),
    )
    store.upsert(
      rec("A2", {
        kind: "running",
        pid: 1,
        startedAt: "2026-05-30T11:58:38.000Z",
        progress: { tools: 14, tokens: 9100, lastActivity: "editing parser.ts" },
      }),
    )
    const text = new SubagentsAttachment("lead", { dir }, () => NOW).toText()
    expect(text).not.toBeNull()
    const t = text as string
    expect(t.startsWith('<ma::agent::subagents active="1" done="1" failed="0"')).toBe(true)
    expect(t).toContain("A2")
    expect(t).toContain("running")
    expect(t).toContain("editing parser.ts")
    expect(t).toContain("A1") // recent terminal shown too
    expect(t.endsWith("</ma::agent::subagents>")).toBe(true)
  })

  it("caps rows with a +N more overflow", () => {
    const store = new SubagentStore("lead", { dir })
    for (let i = 1; i <= 12; i++) {
      store.upsert(
        rec(`A${i}`, {
          kind: "running",
          pid: i,
          startedAt: "2026-05-30T11:59:00.000Z",
          progress: { tools: 0, tokens: 0 },
        }),
      )
    }
    const t = new SubagentsAttachment("lead", { dir }, () => NOW).toText() as string
    expect(t).toContain("more (ListAgents)")
  })

  // Relocated from the core seam test (src/agent.turn-attachments.test.ts,
  // Wave A unit A-4): the core file may not import this plugin (invariant
  // I2), so the single-running-worker and empty-session shapes the agent
  // surfaces are characterized here, against a real SubagentStore. The
  // agent-side seam (a producer's block is injected in array order / a null
  // producer adds nothing) stays in the core file with an in-test fake
  // producer.
  it("toAttachment surfaces the fleet (worker id + running) when ONE worker is active", () => {
    const store = new SubagentStore("lead", { dir })
    store.upsert(
      rec("A1", {
        kind: "running",
        pid: 1,
        startedAt: "2026-05-30T11:59:00.000Z",
        progress: { tools: 0, tokens: 0 },
      }),
    )
    const att = new SubagentsAttachment("lead", { dir }, () => NOW).toAttachment()
    expect(att).not.toBeNull()
    expect(att!.type).toBe("text")
    const text = (att as { text: string }).text
    expect(text).toContain("<ma::agent::subagents")
    expect(text).toContain("A1")
    expect(text).toContain("running")
  })

  it("toAttachment returns null for an empty session (no workers at all)", () => {
    // Construct the store but add nothing — the session has zero workers.
    const _store = new SubagentStore("lead", { dir })
    void _store
    expect(new SubagentsAttachment("lead", { dir }, () => NOW).toAttachment()).toBeNull()
  })
})

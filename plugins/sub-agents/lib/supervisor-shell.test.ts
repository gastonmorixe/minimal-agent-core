import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { readMesh } from "./presence.ts"
import { type ProbeDeps } from "./spawn.ts"
import { SubagentStore } from "./store.ts"
import { runSupervisor, type SupervisorDeps } from "./supervisor-shell.ts"
import { type ResultDigest, type SubagentRecord, sessionId, subagentId } from "./types.ts"

const LEAD = "11111111-1111-4111-8111-111111111111"
const RESULT: ResultDigest = { short: "found it", tokens: 4000, tools: 9 }

function running(id: string, pid: number): SubagentRecord {
  return {
    id: subagentId(id),
    sid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
    label: "explorer",
    type: "explorer",
    model: "claude-haiku-4-5",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: "2026-05-30T11:59:00.000Z",
    status: {
      kind: "running",
      pid,
      startedAt: "2026-05-30T11:59:00.000Z",
      progress: { tools: 0, tokens: 0 },
    },
    depth: 1,
    leadSid: sessionId(LEAD),
  }
}

function makeDeps(
  store: SubagentStore,
  probe: ProbeDeps,
  over: Partial<SupervisorDeps> = {},
): SupervisorDeps & { emitted: { channel: string; payload: unknown }[]; killed: number[] } {
  const emitted: { channel: string; payload: unknown }[] = []
  const killed: number[] = []
  return {
    store,
    probeDeps: probe,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    kill: (pid) => killed.push(pid),
    sessionsDir: "/tmp/ignored",
    leadSid: LEAD,
    now: () => new Date("2026-05-30T12:00:00.000Z"),
    tick: 0,
    ansi: false,
    emitted,
    killed,
    ...over,
  }
}

describe("runSupervisor", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-sup-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("keeps a running worker running while alive and paints the widget", () => {
    const store = new SubagentStore(LEAD, { dir })
    store.upsert(running("A1", 4242))
    const deps = makeDeps(store, { pidAlive: () => true, readResult: () => undefined })
    const widget = runSupervisor(deps)
    expect(store.get("A1")?.status.kind).toBe("running")
    expect(widget).not.toBeNull()
    expect(widget).toContain("◈ fleet")
    expect(deps.emitted).toHaveLength(0)
  })

  it("refreshes a running worker's live progress from the probe", () => {
    const store = new SubagentStore(LEAD, { dir })
    store.upsert(running("A1", 4242))
    const deps = makeDeps(store, {
      pidAlive: () => true,
      readResult: () => undefined,
      readProgress: () => ({
        tools: 9,
        tokens: 8200,
        lastTool: "Edit",
        lastActivity: "Edit: src/x.ts",
      }),
    })
    runSupervisor(deps)
    const st = store.get("A1")?.status
    expect(st?.kind).toBe("running")
    if (st?.kind === "running") {
      expect(st.progress.tools).toBe(9)
      expect(st.progress.tokens).toBe(8200)
      expect(st.progress.lastActivity).toBe("Edit: src/x.ts")
    }
  })

  it("reaps a finished worker: persists done, emits report+exit, injects a digest", () => {
    const store = new SubagentStore(LEAD, { dir })
    store.upsert(running("A1", 4242))
    const deps = makeDeps(store, {
      pidAlive: () => false,
      readResult: () => RESULT,
      exitCode: () => 0,
    })
    const widget = runSupervisor(deps)
    expect(store.get("A1")?.status.kind).toBe("done")
    const channels = deps.emitted.map((e) => e.channel)
    expect(channels).toContain("subagent.didReport")
    expect(channels).toContain("subagent.didExit")
    const inject = deps.emitted.find((e) => e.channel === "prompt.inject")
    expect(inject).toBeDefined()
    const injectText = inject ? (inject.payload as { text: string }).text : ""
    expect(injectText).toContain("AgentResult A1")
    // fleet now has no active workers → widget collapses
    expect(widget).toBeNull()
  })

  it("publishes presence (lead + fleet) when a presenceDir is set", () => {
    const store = new SubagentStore(LEAD, { dir })
    store.upsert(running("A1", 4242))
    const presenceDir = `${dir}/presence`
    const deps = makeDeps(
      store,
      { pidAlive: () => true, readResult: () => undefined },
      {
        presenceDir,
        leadPid: 999,
        leadModel: "claude-opus-4-8",
        leadCwd: "/repo",
      },
    )
    runSupervisor(deps)
    const mesh = readMesh(presenceDir)
    expect(mesh.get(LEAD)?.role).toBe("lead")
    expect(mesh.get(LEAD)?.pid).toBe(999)
    // the worker's own sid is in the mesh as a worker row
    const worker = [...mesh.values()].find((r) => r.role === "worker")
    expect(worker?.status).toBe("active")
  })

  it("kills a budget-tripped worker (deadline) and marks it failed", () => {
    const store = new SubagentStore(LEAD, { dir })
    const r = running("A1", 4242)
    if (r.status.kind !== "running") throw new Error("expected running status")
    store.upsert({
      ...r,
      status: { ...r.status, startedAt: "2026-05-30T11:58:00.000Z" },
      budget: { deadlineSec: 60 },
    })
    const deps = makeDeps(store, { pidAlive: () => true, readResult: () => undefined })
    runSupervisor(deps)
    expect(store.get("A1")?.status.kind).toBe("failed")
    expect(deps.killed).toEqual([4242])
  })
})

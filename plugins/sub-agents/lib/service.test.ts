import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { type ServiceDeps, spawnAgent, stopAgent, type WorkerDefinition } from "./service.ts"
import { type SpawnDeps } from "./spawn.ts"
import { SubagentStore } from "./store.ts"
import { sessionId } from "./types.ts"

const LEAD = sessionId("11111111-1111-4111-8111-111111111111")
const FIXED_SID = "9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"

function makeDeps(dir: string, over: Partial<ServiceDeps> = {}): ServiceDeps & { launched: string[][] } {
  const launched: string[][] = []
  const spawnDeps: SpawnDeps = {
    launch: (argv) => {
      launched.push([...argv])
      return 5000 + launched.length
    },
  }
  return {
    store: new SubagentStore(LEAD, { dir }),
    spawnDeps,
    agentBin: ["minimal-agent"],
    leadSid: LEAD,
    depth: 0,
    cwd: "/repo",
    sessionsDir: dir,
    defaultModel: "claude-sonnet-4-6",
    newSid: () => FIXED_SID,
    now: () => new Date("2026-05-30T12:00:00.000Z"),
    launched,
    ...over,
  }
}

describe("spawnAgent", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-svc-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("launches a worker, persists a running handle, returns it", () => {
    const deps = makeDeps(dir)
    const r = spawnAgent({ task: "refactor parser" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.id).toBe("A1")
    expect(r.value.status.kind).toBe("running")
    if (r.value.status.kind === "running") expect(r.value.status.pid).toBe(5001)
    // persisted
    expect(deps.store.get("A1")?.sid).toBe(FIXED_SID)
    // launched with the pinned sid + the task
    expect(deps.launched[0]).toContain("--session-id")
    expect(deps.launched[0]?.at(-1)).toBe("refactor parser")
  })

  it("rejects an empty task without launching", () => {
    const deps = makeDeps(dir)
    const r = spawnAgent({ task: "   " }, deps)
    expect(r.ok).toBe(false)
    expect(deps.launched).toHaveLength(0)
  })

  it("enforces the nesting ban from a worker (depth 1 → childDepth 2)", () => {
    const deps = makeDeps(dir, { depth: 1 })
    const r = spawnAgent({ task: "spawn a grandchild" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/nesting/i)
    expect(deps.launched).toHaveLength(0)
  })

  it("resolves a named definition (model + system preamble)", () => {
    const reviewer: WorkerDefinition = {
      name: "reviewer",
      model: "claude-opus-4-8",
      systemPrompt: "You are a strict reviewer.",
      isolation: "fresh",
    }
    const deps = makeDeps(dir, { resolveDefinition: (n) => (n === "reviewer" ? reviewer : undefined) })
    const r = spawnAgent({ task: "review the diff", agent: "reviewer" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.type).toBe("reviewer")
    expect(r.value.model).toBe("claude-opus-4-8")
    // the system preamble is folded into the launched prompt
    expect(deps.launched[0]?.at(-1)).toContain("You are a strict reviewer.")
  })

  it("threads isolation=fork through to a --resume <leadSid> launch", () => {
    const deps = makeDeps(dir)
    const r = spawnAgent({ task: "side task with my context", isolation: "fork" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.isolation).toBe("fork")
    const argv = deps.launched[0] ?? []
    // fork resumes the lead so its history forks into the pinned child sid.
    expect(argv[argv.indexOf("--resume") + 1]).toBe(LEAD)
    expect(argv).toContain("--session-id")
  })

  it("rejects an unknown definition name", () => {
    const deps = makeDeps(dir, { resolveDefinition: () => undefined })
    const r = spawnAgent({ task: "x", agent: "ghost" }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/unknown sub-agent/i)
  })
})

describe("stopAgent", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-stop-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("kills the pid and marks the worker stopped", () => {
    const deps = makeDeps(dir)
    const sp = spawnAgent({ task: "long job" }, deps)
    expect(sp.ok).toBe(true)
    const killed: number[] = []
    const r = stopAgent("A1", "superseded", {
      store: deps.store,
      kill: (pid) => killed.push(pid),
      now: () => new Date("2026-05-30T12:05:00.000Z"),
    })
    expect(r.ok).toBe(true)
    expect(killed).toEqual([5001])
    expect(deps.store.get("A1")?.status.kind).toBe("stopped")
  })

  it("is a no-op on an unknown id (err) and idempotent on a terminal worker", () => {
    const deps = makeDeps(dir)
    const miss = stopAgent("ZZ", undefined, { store: deps.store, kill: () => {}, now: () => new Date() })
    expect(miss.ok).toBe(false)
  })
})

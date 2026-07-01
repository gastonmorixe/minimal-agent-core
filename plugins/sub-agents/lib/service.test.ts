import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { type ServiceDeps, spawnAgent, stopAgent, type WorkerDefinition } from "./service.ts"
import { type SpawnDeps } from "./spawn.ts"
import { SubagentStore } from "./store.ts"
import { sessionId, subagentId } from "./types.ts"

const LEAD = sessionId("11111111-1111-4111-8111-111111111111")
const FIXED_SID = "9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"

function makeDeps(
  dir: string,
  over: Partial<ServiceDeps> = {},
): ServiceDeps & { launched: string[][] } {
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
    expect(r.value.id).toBe(subagentId("A1"))
    expect(r.value.status.kind).toBe("running")
    if (r.value.status.kind === "running") expect(r.value.status.pid).toBe(5001)
    // persisted
    expect(deps.store.get("A1")?.sid).toBe(sessionId(FIXED_SID))
    // launched with the pinned sid + the task (now followed by the REQUIRED
    // deliverable protocol, so the prompt CONTAINS the task rather than equals it)
    expect(deps.launched[0]).toContain("--session-id")
    const prompt = deps.launched[0]?.at(-1) ?? ""
    expect(prompt).toContain("refactor parser")
    // the deliverable protocol tells the worker to hand back via ReportResult
    expect(prompt).toMatch(/ReportResult/)
    // and the manual-fallback path points at this worker's own result.json sentinel
    expect(prompt).toContain(".result.json")
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
    const deps = makeDeps(dir, {
      resolveDefinition: (n) => (n === "reviewer" ? reviewer : undefined),
    })
    const r = spawnAgent({ task: "review the diff", agent: "reviewer" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.type).toBe("reviewer")
    expect(r.value.model).toBe("claude-opus-4-8")
    // the system preamble is folded into the launched prompt
    expect(deps.launched[0]?.at(-1)).toContain("You are a strict reviewer.")
  })

  it("inherits deps.defaultModel (the lead's model) when the request omits one", () => {
    const deps = makeDeps(dir, { defaultModel: "gpt-5.5" })
    const r = spawnAgent({ task: "inherit my model" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.model).toBe("gpt-5.5")
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-5.5")
  })

  it("OMITS --model when no model is knowable (model-agnostic; child self-resolves)", () => {
    const deps = makeDeps(dir, { defaultModel: "" })
    const r = spawnAgent({ task: "no model anywhere" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.model).toBe("")
    const argv = deps.launched[0] ?? []
    expect(argv).not.toContain("--model")
  })

  it("a per-spawn model overrides the inherited default", () => {
    const deps = makeDeps(dir, { defaultModel: "gpt-5.5" })
    const r = spawnAgent({ task: "override", model: "claude-opus-4-8" }, deps)
    expect(r.ok && r.value.model).toBe("claude-opus-4-8")
  })

  it("uses the provider's role recommendation for a role-bearing specialist (Phase G)", () => {
    const scout: WorkerDefinition = { name: "explorer", role: "scout", systemPrompt: "scout" }
    const deps = makeDeps(dir, {
      defaultModel: "lead-model-x",
      resolveDefinition: (n) => (n === "explorer" ? scout : undefined),
      recommendForRole: (role) =>
        role === "scout" ? { modelId: "provider-scout-model", effort: "low" } : undefined,
    })
    const r = spawnAgent({ task: "scan", agent: "explorer" }, deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // the role recommendation beat the lead default
    expect(r.value.model).toBe("provider-scout-model")
    // and the recommended effort rode along on the launch
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--effort") + 1]).toBe("low")
  })

  it("falls back to the lead model when the provider recommends nothing for the role", () => {
    const deep: WorkerDefinition = { name: "reviewer", role: "deep", systemPrompt: "review" }
    const deps = makeDeps(dir, {
      defaultModel: "lead-model-x",
      resolveDefinition: (n) => (n === "reviewer" ? deep : undefined),
      recommendForRole: () => undefined, // provider has no rec for this role
    })
    const r = spawnAgent({ task: "review", agent: "reviewer" }, deps)
    expect(r.ok && r.value.model).toBe("lead-model-x")
  })

  it("an explicit per-spawn model still wins over a role recommendation", () => {
    const scout: WorkerDefinition = { name: "explorer", role: "scout", systemPrompt: "scout" }
    const deps = makeDeps(dir, {
      defaultModel: "lead-model-x",
      resolveDefinition: (n) => (n === "explorer" ? scout : undefined),
      recommendForRole: () => ({ modelId: "provider-scout-model" }),
    })
    const r = spawnAgent({ task: "scan", agent: "explorer", model: "user-pick" }, deps)
    expect(r.ok && r.value.model).toBe("user-pick")
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

  it("launches a read-only specialist with --mode ask (Edit/Write denied at dispatch)", () => {
    const readonly: WorkerDefinition = { name: "explorer", role: "scout", mode: "ask" }
    const deps = makeDeps(dir, {
      resolveDefinition: (n) => (n === "explorer" ? readonly : undefined),
    })
    const r = spawnAgent({ task: "find the bug", agent: "explorer" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--mode") + 1]).toBe("ask")
  })

  it("launches an implementer with --mode none (writable) when the definition sets no mode", () => {
    const writer: WorkerDefinition = { name: "worker", role: "balanced" }
    const deps = makeDeps(dir, {
      resolveDefinition: (n) => (n === "worker" ? writer : undefined),
    })
    const r = spawnAgent({ task: "implement it", agent: "worker" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--mode") + 1]).toBe("none")
  })

  it("defaults an inline (definition-less) worker to --mode none", () => {
    const deps = makeDeps(dir)
    const r = spawnAgent({ task: "inline work" }, deps)
    expect(r.ok).toBe(true)
    const argv = deps.launched[0] ?? []
    expect(argv[argv.indexOf("--mode") + 1]).toBe("none")
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
    const miss = stopAgent("ZZ", undefined, {
      store: deps.store,
      kill: () => {},
      now: () => new Date(),
    })
    expect(miss.ok).toBe(false)
  })
})

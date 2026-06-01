import { describe, expect, it } from "bun:test"

import { buildSpawnPlan, type SpawnInput } from "./spawn-plan.ts"
import { cachedProgressReader, launchWorker, parseResultDigest, probeWorker, type SpawnDeps } from "./spawn.ts"
import { type Progress, sessionId, subagentId } from "./types.ts"

function plan(isolation: "fresh" | "fork" = "fresh") {
  const input: SpawnInput = {
    agentBin: ["minimal-agent"],
    childSid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
    leadSid: sessionId("11111111-1111-4111-8111-111111111111"),
    id: subagentId("A2"),
    task: "do",
    model: "claude-haiku-4-5",
    mode: "none",
    isolation,
    depth: 1,
    cwd: "/repo",
  }
  const r = buildSpawnPlan(input)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe("launchWorker", () => {
  it("launches and returns the pid (fresh)", () => {
    let launched: { argv: readonly string[]; cwd: string } | null = null
    const deps: SpawnDeps = {
      launch: (argv, opts) => {
        launched = { argv, cwd: opts.cwd }
        return 4321
      },
    }
    const r = launchWorker(plan("fresh"), deps, "/tmp/x.log")
    expect(r.ok && r.value).toBe(4321)
    expect(launched?.cwd).toBe("/repo")
    expect(launched?.argv[0]).toBe("minimal-agent")
  })

  it("launches a fork worker via --resume (no pre-step)", () => {
    let argv: readonly string[] = []
    const deps: SpawnDeps = {
      launch: (a) => {
        argv = a
        return 7
      },
    }
    const r = launchWorker(plan("fork"), deps, "/tmp/x.log")
    expect(r.ok).toBe(true)
    expect(argv).toContain("--resume")
  })

  it("surfaces a spawn failure as an err value", () => {
    const deps: SpawnDeps = {
      launch: () => {
        throw new Error("ENOENT")
      },
    }
    const r = launchWorker(plan("fresh"), deps, "/tmp/x.log")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/spawn failed/i)
  })
})

const target = (pid: number) => ({ pid, resultPath: "/tmp/r.json", transcriptPath: "/tmp/t.jsonl" })

describe("probeWorker", () => {
  it("reports alive WITH live progress, without reading a result", () => {
    const probe = probeWorker(target(99), {
      pidAlive: () => true,
      readResult: () => {
        throw new Error("should not read result while alive")
      },
      readProgress: () => ({ tools: 7, tokens: 4200, lastTool: "Grep" }),
    })
    expect(probe.alive).toBe(true)
    expect(probe.progress).toEqual({ tools: 7, tokens: 4200, lastTool: "Grep" })
  })

  it("reports the result + exit code once the pid is gone", () => {
    const probe = probeWorker(target(99), {
      pidAlive: () => false,
      readResult: () => ({ short: "done it", tokens: 100, tools: 3 }),
      exitCode: () => 0,
    })
    expect(probe.alive).toBe(false)
    expect(probe.result?.short).toBe("done it")
    expect(probe.exitCode).toBe(0)
  })
})

describe("cachedProgressReader", () => {
  const PROG: Progress = { tools: 3, tokens: 100 }

  it("parses once for an unchanged mtime, re-parses when mtime changes", () => {
    let mtime = 10
    let parses = 0
    const read = cachedProgressReader({
      stat: () => mtime,
      read: () => "ignored",
      parse: () => {
        parses++
        return PROG
      },
    })
    expect(read("/t.jsonl")).toEqual(PROG)
    expect(read("/t.jsonl")).toEqual(PROG)
    expect(parses).toBe(1) // second read hit the cache (same mtime)
    mtime = 20
    read("/t.jsonl")
    expect(parses).toBe(2) // mtime changed → re-parsed
  })

  it("returns undefined when the file is absent (stat null)", () => {
    const read = cachedProgressReader({ stat: () => null, read: () => "", parse: () => PROG })
    expect(read("/missing")).toBeUndefined()
  })

  it("caches per-path independently", () => {
    let parses = 0
    const read = cachedProgressReader({
      stat: () => 5,
      read: () => "",
      parse: () => {
        parses++
        return PROG
      },
    })
    read("/a")
    read("/b")
    read("/a")
    expect(parses).toBe(2) // /a and /b parsed once each; /a's repeat cached
  })
})

describe("parseResultDigest", () => {
  it("accepts a valid sentinel and coerces missing counts to 0", () => {
    expect(parseResultDigest({ short: "ok" })).toEqual({ short: "ok", tokens: 0, tools: 0 })
    expect(parseResultDigest({ short: "ok", tokens: 5, tools: 2, artifacts: ["a", 7] })).toEqual({
      short: "ok",
      tokens: 5,
      tools: 2,
      artifacts: ["a"],
    })
  })
  it("rejects malformed input", () => {
    expect(parseResultDigest(null)).toBeUndefined()
    expect(parseResultDigest({ tokens: 1 })).toBeUndefined() // no short
    expect(parseResultDigest("nope")).toBeUndefined()
  })
})

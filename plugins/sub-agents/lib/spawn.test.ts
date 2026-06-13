import { describe, expect, it } from "bun:test"

import {
  cachedProgressReader,
  extractCrashSignature,
  launchWorker,
  parseResultDigest,
  probeWorker,
  type SpawnDeps,
} from "./spawn.ts"
import { buildSpawnPlan, type SpawnInput } from "./spawn-plan.ts"
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
    // TS control-flow can't see the closure ran; re-widen before reading.
    const got = launched as { argv: readonly string[]; cwd: string } | null
    expect(got?.cwd).toBe("/repo")
    expect(got?.argv[0]).toBe("minimal-agent")
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
      readFinalText: () => "should be ignored when a sentinel exists",
      exitCode: () => 0,
    })
    expect(probe.alive).toBe(false)
    expect(probe.result?.short).toBe("done it")
    expect(probe.exitCode).toBe(0)
    // sentinel wins: distillation is not even surfaced
    expect(probe.distilled).toBeUndefined()
  })

  it("falls back to distilled final text when there is NO sentinel", () => {
    const probe = probeWorker(target(99), {
      pidAlive: () => false,
      readResult: () => undefined,
      readFinalText: () => "my final synthesis",
      exitCode: () => 0,
    })
    expect(probe.alive).toBe(false)
    expect(probe.result).toBeUndefined()
    expect(probe.distilled).toBe("my final synthesis")
  })

  it("leaves distilled undefined when neither sentinel nor final text exists", () => {
    const probe = probeWorker(target(99), {
      pidAlive: () => false,
      readResult: () => undefined,
      readFinalText: () => undefined,
      exitCode: () => 0,
    })
    expect(probe.result).toBeUndefined()
    expect(probe.distilled).toBeUndefined()
  })

  it("reports missingArtifacts for an unmet expectArtifacts contract (FIX 4)", () => {
    const probe = probeWorker(
      {
        pid: 1,
        resultPath: "/r.json",
        transcriptPath: "/t.jsonl",
        expectArtifacts: ["/a.md", "/b.md"],
      },
      {
        pidAlive: () => false,
        readResult: () => undefined,
        missingArtifacts: (paths) => paths.filter((p) => p === "/b.md"),
        exitCode: () => 0,
      },
    )
    expect(probe.missingArtifacts).toEqual(["/b.md"])
  })

  it("omits missingArtifacts when the contract is met", () => {
    const probe = probeWorker(
      { pid: 1, resultPath: "/r.json", transcriptPath: "/t.jsonl", expectArtifacts: ["/a.md"] },
      {
        pidAlive: () => false,
        readResult: () => undefined,
        missingArtifacts: () => [],
        exitCode: () => 0,
      },
    )
    expect(probe.missingArtifacts).toBeUndefined()
  })

  it("prepends a ⚠ warning when a sentinel's OWN declared artifacts are missing (FIX 3)", () => {
    const probe = probeWorker(target(1), {
      pidAlive: () => false,
      readResult: () => ({
        short: "did the thing",
        tokens: 9,
        tools: 2,
        artifacts: ["/x.md", "/y.md"],
      }),
      missingArtifacts: (paths) => paths.filter((p) => p === "/y.md"),
      exitCode: () => 0,
    })
    expect(probe.result?.short).toMatch(/⚠ 1\/2 declared artifact\(s\) missing: \/y\.md/)
    expect(probe.result?.short).toContain("did the thing")
  })

  // FIX A: when a worker exited producing nothing, the probe mines the log.
  it("reads a crash signature when the worker exited with NO sentinel and NO final text (FIX A)", () => {
    const probe = probeWorker(
      { pid: 1, resultPath: "/r.json", transcriptPath: "/t.jsonl", logPath: "/w.log" },
      {
        pidAlive: () => false,
        readResult: () => undefined,
        readFinalText: () => undefined,
        readCrash: () => "fatal: API 400: long context beta not available",
        exitCode: () => undefined,
      },
    )
    expect(probe.crash).toMatch(/long context beta/i)
  })

  it("does NOT read the crash log when a sentinel exists (cheap path preserved)", () => {
    const probe = probeWorker(
      { pid: 1, resultPath: "/r.json", transcriptPath: "/t.jsonl", logPath: "/w.log" },
      {
        pidAlive: () => false,
        readResult: () => ({ short: "ok", tokens: 1, tools: 1 }),
        readCrash: () => {
          throw new Error("should not read the crash log when a sentinel exists")
        },
        exitCode: () => 0,
      },
    )
    expect(probe.crash).toBeUndefined()
    expect(probe.result?.short).toBe("ok")
  })

  it("does NOT read the crash log when a final message was distilled", () => {
    const probe = probeWorker(
      { pid: 1, resultPath: "/r.json", transcriptPath: "/t.jsonl", logPath: "/w.log" },
      {
        pidAlive: () => false,
        readResult: () => undefined,
        readFinalText: () => "my synthesis",
        readCrash: () => {
          throw new Error("should not read the crash log when there is a final message")
        },
        exitCode: () => 0,
      },
    )
    expect(probe.crash).toBeUndefined()
    expect(probe.distilled).toBe("my synthesis")
  })
})

describe("extractCrashSignature", () => {
  it("pulls the real cause from the A1-class boot crash", () => {
    const log =
      'fatal: API 400: {"type":"error","error":{"type":"invalid_request_error",' +
      '"message":"The long context beta is not yet available for this subscription."}}'
    expect(extractCrashSignature(log)).toMatch(/long context beta/i)
    expect(extractCrashSignature(log)?.startsWith("fatal:")).toBe(true)
  })

  it("matches an unknown-model complaint", () => {
    expect(extractCrashSignature("error: unknown model 'claude-opus-4-1'")).toMatch(
      /unknown model/i,
    )
  })

  it("matches a Node spawn ENOENT", () => {
    expect(extractCrashSignature("Error: spawn minimal-agent ENOENT")).toMatch(/ENOENT/)
  })

  it("strips ANSI before scanning", () => {
    const log = "\x1b[31mfatal:\x1b[39m boom"
    expect(extractCrashSignature(log)).toBe("fatal: boom")
  })

  it("returns undefined for a benign / empty log (no false positive)", () => {
    expect(extractCrashSignature("")).toBeUndefined()
    expect(extractCrashSignature("starting up\nWebSearch ok\ndone")).toBeUndefined()
  })

  it("returns the FIRST fatal line, clipped", () => {
    const log = "noise\nfatal: first cause\nfatal: second cause"
    expect(extractCrashSignature(log)).toBe("fatal: first cause")
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
  it("honors a structured incomplete flag", () => {
    expect(parseResultDigest({ short: "partial", incomplete: true })?.incomplete).toBe(true)
  })
  it("recognizes a legacy hand-written INCOMPLETE: prefix as incomplete", () => {
    // The documented manual-sentinel fallback has no structured field, just the
    // prefix. The supervisor must still route it to incomplete, not done.
    expect(parseResultDigest({ short: "INCOMPLETE: ran out of time" })?.incomplete).toBe(true)
  })
  it("leaves incomplete unset for an ordinary finished sentinel", () => {
    expect(parseResultDigest({ short: "found 3 callers" })?.incomplete).toBeUndefined()
  })
})

import { describe, expect, it } from "bun:test"

import { type Effect, supervisorTick, type WorkerProbe } from "./supervisor.ts"
import {
  type Progress,
  type ResultDigest,
  type SubagentRecord,
  type SubagentStatus,
  sessionId,
  subagentId,
} from "./types.ts"

const NOW = "2026-05-30T12:00:00.000Z"
const NOW_MS = Date.parse(NOW)
const PROG: Progress = { tools: 4, tokens: 1200, lastTool: "Grep" }
const RESULT: ResultDigest = { short: "found 3 callers", tokens: 5000, tools: 12 }

function rec(id: string, status: SubagentStatus, budgetSec?: number): SubagentRecord {
  return {
    id: subagentId(id),
    sid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
    label: "explorer",
    type: "explorer",
    model: "claude-haiku-4-5",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: NOW,
    status,
    depth: 1,
    leadSid: sessionId("11111111-1111-4111-8111-111111111111"),
    ...(budgetSec ? { budget: { deadlineSec: budgetSec } } : {}),
  }
}

function running(startedAt = NOW): SubagentStatus {
  return { kind: "running", pid: 4242, startedAt, progress: { tools: 0, tokens: 0 } }
}

function tick(records: SubagentRecord[], probes: Record<string, WorkerProbe>, nowMs = NOW_MS) {
  return supervisorTick({ records, probes: new Map(Object.entries(probes)), now: NOW, nowMs })
}

describe("supervisorTick — running transitions", () => {
  it("refreshes progress while alive (no effects)", () => {
    const out = tick([rec("A1", running())], { A1: { alive: true, progress: PROG } })
    expect(out.changed).toBe(true)
    expect(out.effects).toEqual([])
    const st = out.records[0]?.status
    expect(st?.kind === "running" && st.progress).toEqual(PROG)
  })

  it("leaves a running worker untouched when there is no probe", () => {
    const r = rec("A1", running())
    const out = tick([r], {})
    expect(out.changed).toBe(false)
    expect(out.records[0]).toBe(r) // same reference, no churn
  })

  it("transitions running → done with a result and emits report + inject", () => {
    const out = tick([rec("A1", running())], { A1: { alive: false, exitCode: 0, result: RESULT } })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("done")
    if (st?.kind === "done") expect(st.result).toEqual(RESULT)
    const kinds = out.effects.map((e: Effect) => e.type)
    expect(kinds).toEqual(["emit", "emit", "inject"])
    const inject = out.effects.find((e) => e.type === "inject")
    expect(inject?.type === "inject" && inject.text).toContain("AgentResult A1")
    expect(inject?.type === "inject" && inject.source).toBe("subagent:A1")
  })

  it("transitions running → failed on non-zero exit without a result", () => {
    const out = tick([rec("A1", running())], { A1: { alive: false, exitCode: 1 } })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("failed")
    if (st?.kind === "failed") expect(st.exitCode).toBe(1)
  })

  it("transitions running → INCOMPLETE on clean exit with no result (NOT laundered into done)", () => {
    const prog: Progress = { tools: 9, tokens: 4242 }
    const out = tick([rec("A1", { kind: "running", pid: 4242, startedAt: NOW, progress: prog })], {
      A1: { alive: false, exitCode: 0 },
    })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("incomplete")
    if (st?.kind === "incomplete") {
      expect(st.reason).toMatch(/without a result sentinel/i)
      // carries the effort spent so the widget can still show it
      expect(st.tokens).toBe(4242)
      expect(st.tools).toBe(9)
    }
    // still emits the lifecycle signals + a (loud) digest
    const inject = out.effects.find((e) => e.type === "inject")
    expect(inject?.type === "inject" && inject.text).toMatch(/INCOMPLETE/i)
  })
})

describe("supervisorTick — distilled-final-text fallback (precedence)", () => {
  it("a clean exit with a distilled final message → done, marked distilled", () => {
    const prog: Progress = { tools: 6, tokens: 3300 }
    const out = tick([rec("A1", { kind: "running", pid: 7, startedAt: NOW, progress: prog })], {
      A1: { alive: false, exitCode: 0, distilled: "I analyzed the parser; 3 callers in foo.ts." },
    })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("done")
    if (st?.kind === "done") {
      expect(st.result.short).toBe("I analyzed the parser; 3 callers in foo.ts.")
      expect(st.result.distilled).toBe(true)
      // counts inferred from live progress
      expect(st.result.tokens).toBe(3300)
      expect(st.result.tools).toBe(6)
    }
  })

  it("a real sentinel WINS over distilled text (precedence)", () => {
    const out = tick([rec("A1", running())], {
      A1: { alive: false, exitCode: 0, result: RESULT, distilled: "ignored fallback" },
    })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("done")
    if (st?.kind === "done") {
      expect(st.result).toEqual(RESULT) // the structured sentinel, untouched
      expect(st.result.distilled).toBeUndefined()
    }
  })

  it("nothing at all (no sentinel, no distilled) → incomplete", () => {
    const out = tick([rec("A1", running())], { A1: { alive: false, exitCode: 0 } })
    expect(out.records[0]?.status.kind).toBe("incomplete")
  })
})

describe("supervisorTick — self-reported incompletion is NOT laundered into done", () => {
  it("a sentinel with incomplete:true → incomplete, NOT done, with the summary salvaged", () => {
    const out = tick([rec("A1", running())], {
      A1: {
        alive: false,
        exitCode: 0,
        result: {
          short: "INCOMPLETE: ran out of budget before reading the parser.",
          tokens: 60_000,
          tools: 40,
          incomplete: true,
        },
      },
    })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("incomplete")
    if (st?.kind === "incomplete") {
      // The INCOMPLETE: marker is stripped from the salvaged findings.
      expect(st.salvage).toBe("ran out of budget before reading the parser.")
      expect(st.reason).toMatch(/could not finish/i)
    }
  })

  it("a clean exit code does NOT override a self-reported incompletion", () => {
    const out = tick([rec("A1", running())], {
      A1: {
        alive: false,
        exitCode: 0,
        result: { short: "partial", tokens: 1, tools: 1, incomplete: true },
      },
    })
    expect(out.records[0]?.status.kind).toBe("incomplete")
  })

  it("a linked todo is CANCELED (not ticked done) when the worker self-reports incomplete", () => {
    const r = { ...rec("A1", running()), taskId: "#a7b3c4" }
    const out = tick([r], {
      A1: {
        alive: false,
        exitCode: 0,
        result: { short: "INCOMPLETE: blocked", tokens: 1, tools: 1, incomplete: true },
      },
    })
    const taskUpdate = out.effects.find(
      (e) => e.type === "emit" && e.channel === "subagent.taskUpdate",
    )
    expect(taskUpdate?.type === "emit" && taskUpdate.payload).toMatchObject({
      taskId: "#a7b3c4",
      status: "canceled",
    })
  })

  it("claimed artifacts are surfaced even on a self-reported incompletion", () => {
    const out = tick([rec("A1", running())], {
      A1: {
        alive: false,
        exitCode: 0,
        result: {
          short: "INCOMPLETE: wrote a draft",
          tokens: 1,
          tools: 1,
          artifacts: ["/draft.md"],
          incomplete: true,
        },
      },
    })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("incomplete")
    if (st?.kind === "incomplete") expect(st.artifacts).toEqual(["/draft.md"])
  })

  it("a non-zero exit still fails even if a final message was distilled", () => {
    const out = tick([rec("A1", running())], {
      A1: { alive: false, exitCode: 1, distilled: "I think I crashed" },
    })
    expect(out.records[0]?.status.kind).toBe("failed")
  })

  // FIX A: a boot crash arrives with exitCode UNDEFINED (Bun.spawn is detached,
  // so production has no wait status) but a crash signature mined from the log.
  // It must report `failed` with the real cause, not a generic incomplete.
  it("a crash signature with NO exit code → failed with the real cause (FIX A)", () => {
    const out = tick([rec("A1", running())], {
      A1: { alive: false, crash: 'fatal: API 400: "long context beta is not available"' },
    })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("failed")
    if (st?.kind === "failed") expect(st.error).toMatch(/long context beta/i)
    // the digest the lead sees says "failed", not "incomplete"
    const inject = out.effects.find((e) => e.type === "inject")
    expect(inject?.type === "inject" && inject.text).toMatch(/failed/i)
  })

  it("prefers the crash signature over a bare exit code on non-zero exit (FIX A)", () => {
    const out = tick([rec("A1", running())], {
      A1: { alive: false, exitCode: 1, crash: "fatal: unknown model 'claude-opus-4-1'" },
    })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("failed")
    if (st?.kind === "failed") {
      expect(st.error).toMatch(/unknown model/i)
      expect(st.error).toContain("exit 1")
      expect(st.exitCode).toBe(1)
    }
  })

  it("does NOT escalate to failed when the worker produced a real result, even if a crash line exists", () => {
    const out = tick([rec("A1", running())], {
      A1: { alive: false, exitCode: 0, result: RESULT, crash: "Error: noisy but non-fatal" },
    })
    // a real deliverable wins; the crash signal is only for empty exits
    expect(out.records[0]?.status.kind).toBe("done")
  })
})

describe("supervisorTick — expectArtifacts contract (FIX 4)", () => {
  it("forces INCOMPLETE when required artifacts are missing, even WITH a sentinel", () => {
    const r = { ...rec("A1", running()), expectArtifacts: ["/findings.md"] }
    const out = tick([r], {
      A1: { alive: false, exitCode: 0, result: RESULT, missingArtifacts: ["/findings.md"] },
    })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("incomplete")
    if (st?.kind === "incomplete") {
      expect(st.reason).toMatch(/missing 1\/1 required artifact/i)
      expect(st.reason).toContain("/findings.md")
    }
  })

  it("forces INCOMPLETE over a distilled message too when artifacts are missing", () => {
    const r = { ...rec("A1", running()), expectArtifacts: ["/out.md"] }
    const out = tick([r], {
      A1: { alive: false, exitCode: 0, distilled: "I tried", missingArtifacts: ["/out.md"] },
    })
    expect(out.records[0]?.status.kind).toBe("incomplete")
  })

  it("stays done when the contract is met (no missingArtifacts)", () => {
    const r = { ...rec("A1", running()), expectArtifacts: ["/out.md"] }
    const out = tick([r], { A1: { alive: false, exitCode: 0, result: RESULT } })
    expect(out.records[0]?.status.kind).toBe("done")
  })

  it("SALVAGES the sentinel synthesis onto incomplete when the file is missing (FIX 5, the A2/A3 data-loss bug)", () => {
    const r = { ...rec("A1", running()), expectArtifacts: ["/findings.md"] }
    const out = tick([r], {
      A1: {
        alive: false,
        exitCode: 0,
        result: {
          short: "AVFragmentedAsset is the right API for a growing fMP4.",
          tokens: 58_500,
          tools: 63,
          artifacts: ["/findings.md"],
        },
        missingArtifacts: ["/findings.md"],
      },
    })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("incomplete")
    if (st?.kind === "incomplete") {
      // The findings survive even though the contracted file does not.
      expect(st.salvage).toContain("AVFragmentedAsset")
      // The claimed-but-absent artifact is carried for the lead to verify.
      expect(st.artifacts).toEqual(["/findings.md"])
      // Still a contract miss — the reason names the missing file.
      expect(st.reason).toContain("/findings.md")
    }
    // The between-turns digest tells the lead the findings were salvaged.
    const inject = out.effects.find((e) => e.type === "inject")
    expect(inject?.type === "inject" && inject.text).toMatch(/salvaged/i)
  })

  it("SALVAGES a distilled final message too when there is no sentinel but the file is missing", () => {
    const r = { ...rec("A1", running()), expectArtifacts: ["/out.md"] }
    const out = tick([r], {
      A1: {
        alive: false,
        exitCode: 0,
        distilled: "Here is what I found about the codec.",
        missingArtifacts: ["/out.md"],
      },
    })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("incomplete")
    if (st?.kind === "incomplete") expect(st.salvage).toContain("codec")
  })

  it("leaves salvage undefined when the worker was truly silent AND the file is missing", () => {
    const r = { ...rec("A1", running()), expectArtifacts: ["/out.md"] }
    const out = tick([r], { A1: { alive: false, exitCode: 0, missingArtifacts: ["/out.md"] } })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("incomplete")
    if (st?.kind === "incomplete") expect(st.salvage).toBeUndefined()
  })
})

describe("supervisorTick — tasks linkage", () => {
  it("emits subagent.taskUpdate(done) when a linked worker finishes cleanly", () => {
    const r = { ...rec("A1", running()), taskId: "a7b3c4" }
    const out = tick([r], { A1: { alive: false, exitCode: 0, result: RESULT } })
    const update = out.effects.find((e) => e.type === "emit" && e.channel === "subagent.taskUpdate")
    expect(update).toBeDefined()
    if (update?.type === "emit") {
      expect(update.payload).toMatchObject({ taskId: "a7b3c4", status: "done", bySubagent: "A1" })
    }
  })

  it("emits subagent.taskUpdate(canceled) with a reason when a linked worker fails", () => {
    const r = { ...rec("A1", running()), taskId: "a7b3c4" }
    const out = tick([r], { A1: { alive: false, exitCode: 1 } })
    const update = out.effects.find((e) => e.type === "emit" && e.channel === "subagent.taskUpdate")
    expect(update?.type === "emit" && update.payload).toMatchObject({
      taskId: "a7b3c4",
      status: "canceled",
    })
  })

  it("emits NO taskUpdate for an unlinked worker", () => {
    const out = tick([rec("A1", running())], { A1: { alive: false, exitCode: 0, result: RESULT } })
    expect(out.effects.some((e) => e.type === "emit" && e.channel === "subagent.taskUpdate")).toBe(
      false,
    )
  })

  it("CANCELS a linked todo (not done) when the worker finishes INCOMPLETE", () => {
    const r = { ...rec("A1", running()), taskId: "a7b3c4" }
    const out = tick([r], { A1: { alive: false, exitCode: 0 } })
    // worker itself is incomplete, not done
    expect(out.records[0]?.status.kind).toBe("incomplete")
    const update = out.effects.find((e) => e.type === "emit" && e.channel === "subagent.taskUpdate")
    expect(update?.type === "emit" && update.payload).toMatchObject({
      taskId: "a7b3c4",
      status: "canceled",
      bySubagent: "A1",
    })
    // the cancel reason carries the no-deliverable explanation
    if (update?.type === "emit") {
      const payload = update.payload as { reason?: string }
      expect(payload.reason).toMatch(/no deliverable/i)
    }
  })
})

describe("supervisorTick — budget", () => {
  it("trips a deadline: emits a stop effect and marks failed(timeout)", () => {
    const started = new Date(NOW_MS - 120_000).toISOString() // 2 min ago
    const out = tick([rec("A1", running(started), 60)], { A1: { alive: true, progress: PROG } })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("failed")
    if (st?.kind === "failed") expect(st.error).toMatch(/timed out/i)
    const stop = out.effects.find((e) => e.type === "stop")
    expect(stop?.type === "stop" && stop.pid).toBe(4242)
  })

  it("does not trip before the deadline", () => {
    const started = new Date(NOW_MS - 30_000).toISOString() // 30s ago, budget 60s
    const out = tick([rec("A1", running(started), 60)], { A1: { alive: true } })
    expect(out.records[0]?.status.kind).toBe("running")
  })

  // B-083: an UNBUDGETED worker (no budget.deadlineSec) used to be exempt from
  // the deadline check forever, so a worker wedged mid-finalize leaked its
  // concurrency slot. It must now be reaped via the DEFAULT_DEADLINE_SEC hard
  // ceiling, through the SAME stop + failed(timeout) terminal path.
  it("reaps an UNBUDGETED worker past the default hard deadline (B-083)", () => {
    const started = new Date(NOW_MS - 31 * 60_000).toISOString() // 31 min ago, no budget
    const out = tick([rec("A1", running(started))], { A1: { alive: true, progress: PROG } })
    const st = out.records[0]?.status
    expect(st?.kind).toBe("failed")
    if (st?.kind === "failed") expect(st.error).toMatch(/timed out/i)
    // and it is actually killed (terminal effects emitted, not bypassed)
    const stop = out.effects.find((e) => e.type === "stop")
    expect(stop?.type === "stop" && stop.pid).toBe(4242)
    expect(out.effects.some((e) => e.type === "inject")).toBe(true)
  })

  it("leaves an UNBUDGETED worker running well within the default deadline (B-083)", () => {
    const started = new Date(NOW_MS - 5 * 60_000).toISOString() // 5 min ago, no budget
    const out = tick([rec("A1", running(started))], { A1: { alive: true } })
    expect(out.records[0]?.status.kind).toBe("running")
  })
})

describe("supervisorTick — queued + terminal", () => {
  it("fails a queued worker whose process is already gone (launch failed)", () => {
    const out = tick([rec("A1", { kind: "queued" })], { A1: { alive: false, exitCode: 127 } })
    expect(out.records[0]?.status.kind).toBe("failed")
  })

  it("never re-touches a terminal worker (digest injected exactly once)", () => {
    const done: SubagentStatus = { kind: "done", endedAt: NOW, result: RESULT }
    const out = tick([rec("A1", done)], { A1: { alive: false, result: RESULT } })
    expect(out.changed).toBe(false)
    expect(out.effects).toEqual([])
  })
})

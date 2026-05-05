import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSessionLiveness, livenessFromRecords, type LivenessDeps } from "./session-liveness.ts"
import {
  type AttachRecord,
  type DetachRecord,
  parseLines,
  type SessionRecord,
} from "./session-store.ts"

function attach(over: Partial<AttachRecord> = {}): AttachRecord {
  return {
    kind: "attach",
    ts: "2026-01-01T00:00:00.000Z",
    pid: 1234,
    ppid: 1,
    startTime: "2026-01-01T00:00:00.000Z",
    hostname: "host-a",
    agentVersion: "test",
    ...over,
  }
}

function detach(over: Partial<DetachRecord> = {}): DetachRecord {
  return {
    kind: "detach",
    ts: "2026-01-01T00:01:00.000Z",
    pid: 1234,
    reason: "exit",
    ...over,
  }
}

const HOST = () => "host-a"

describe("livenessFromRecords", () => {
  test("no records → dead/no-attach", () => {
    expect(livenessFromRecords([], { hostname: HOST })).toEqual({
      status: "dead",
      reason: "no-attach",
    })
  })

  test("attach + matching detach → dead/clean-detach", () => {
    const r: SessionRecord[] = [attach(), detach()]
    expect(livenessFromRecords(r, { hostname: HOST })).toEqual({
      status: "dead",
      reason: "clean-detach",
    })
  })

  test("attach with no detach + pid alive + start-time match → live", () => {
    const deps: LivenessDeps = {
      probe: () => "alive",
      readStart: () => "2026-01-01T00:00:00.000Z",
      hostname: HOST,
    }
    const result = livenessFromRecords([attach()], deps)
    expect(result.status).toBe("live")
    if (result.status === "live") {
      expect(result.pid).toBe(1234)
      expect(result.startTime).toBe("2026-01-01T00:00:00.000Z")
    }
  })

  test("attach + kill(0) ESRCH → dead/pid-gone", () => {
    const deps: LivenessDeps = {
      probe: () => "dead",
      readStart: () => null,
      hostname: HOST,
    }
    expect(livenessFromRecords([attach()], deps)).toEqual({
      status: "dead",
      reason: "pid-gone",
      pid: 1234,
    })
  })

  test("attach + pid alive + start-time mismatch → dead/pid-reused", () => {
    const deps: LivenessDeps = {
      probe: () => "alive",
      readStart: () => "2030-06-15T12:00:00.000Z", // different
      hostname: HOST,
    }
    expect(livenessFromRecords([attach()], deps)).toEqual({
      status: "dead",
      reason: "pid-reused",
      pid: 1234,
    })
  })

  test("attach on different host → unknown/remote-host", () => {
    const deps: LivenessDeps = {
      probe: () => {
        throw new Error("should not probe foreign host")
      },
      readStart: () => {
        throw new Error("should not stat foreign host")
      },
      hostname: () => "host-b",
    }
    const result = livenessFromRecords([attach({ hostname: "host-a" })], deps)
    expect(result).toEqual({
      status: "unknown",
      reason: "remote-host",
      pid: 1234,
      hostname: "host-a",
    })
  })

  test("attach + pid alive + ps unavailable → unknown/ps-unavailable", () => {
    const deps: LivenessDeps = {
      probe: () => "alive",
      readStart: () => null,
      hostname: HOST,
    }
    expect(livenessFromRecords([attach()], deps)).toEqual({
      status: "unknown",
      reason: "ps-unavailable",
      pid: 1234,
      hostname: "host-a",
    })
  })

  test("multiple attach/detach pairs → only the latest unmatched matters", () => {
    // First attach was detached cleanly. Second attach is still live.
    const r: SessionRecord[] = [
      attach({ pid: 100, ts: "2026-01-01T00:00:00.000Z", startTime: "S100" }),
      detach({ pid: 100 }),
      attach({ pid: 200, ts: "2026-01-01T00:10:00.000Z", startTime: "S200" }),
    ]
    const deps: LivenessDeps = {
      probe: (pid) => (pid === 200 ? "alive" : "dead"),
      readStart: (pid) => (pid === 200 ? "S200" : null),
      hostname: HOST,
    }
    const result = livenessFromRecords(r, deps)
    expect(result.status).toBe("live")
    if (result.status === "live") expect(result.pid).toBe(200)
  })

  test("detach for a different pid does NOT close an unrelated attach", () => {
    // Attach pid=200 still open; stray detach for pid=999 must not match.
    const r: SessionRecord[] = [attach({ pid: 200, startTime: "S200" }), detach({ pid: 999 })]
    const deps: LivenessDeps = {
      probe: () => "alive",
      readStart: () => "S200",
      hostname: HOST,
    }
    expect(livenessFromRecords(r, deps).status).toBe("live")
  })

  test("permission-denied + start-time mismatch → dead/pid-reused", () => {
    const deps: LivenessDeps = {
      probe: () => "permission-denied",
      readStart: () => "OTHER",
      hostname: HOST,
    }
    expect(livenessFromRecords([attach()], deps)).toEqual({
      status: "dead",
      reason: "pid-reused",
      pid: 1234,
    })
  })

  test("permission-denied + ps unavailable → unknown/permission-denied", () => {
    const deps: LivenessDeps = {
      probe: () => "permission-denied",
      readStart: () => null,
      hostname: HOST,
    }
    expect(livenessFromRecords([attach()], deps)).toEqual({
      status: "unknown",
      reason: "permission-denied",
      pid: 1234,
      hostname: "host-a",
    })
  })
})

describe("getSessionLiveness (file I/O)", () => {
  test("missing file → dead/no-attach", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-liveness-"))
    expect(getSessionLiveness("nope", { dir, hostname: HOST })).toEqual({
      status: "dead",
      reason: "no-attach",
    })
  })

  test("real file → parses and resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-liveness-"))
    const sid = "abc"
    const lines = [
      JSON.stringify({
        kind: "meta",
        formatVersion: 1,
        sid,
        createdAt: "x",
        model: "m",
        cwd: "/",
        systemHash: "h",
        toolsHash: "t",
        agentVersion: "v",
      }),
      JSON.stringify(attach({ pid: 4242, startTime: "STARTX" })),
    ].join("\n")
    writeFileSync(join(dir, `${sid}.jsonl`), `${lines}\n`)

    const result = getSessionLiveness(sid, {
      dir,
      hostname: HOST,
      probe: (pid) => (pid === 4242 ? "alive" : "dead"),
      readStart: (pid) => (pid === 4242 ? "STARTX" : null),
    })
    expect(result.status).toBe("live")
    if (result.status === "live") expect(result.pid).toBe(4242)
  })

  test("torn last line is tolerated (no crash)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-liveness-"))
    const sid = "torn"
    const text =
      `${JSON.stringify(attach({ pid: 5, startTime: "S" }))}\n` +
      `{"kind":"detach","ts":"x","pid":5` // truncated, no closing brace, no newline
    writeFileSync(join(dir, `${sid}.jsonl`), text)
    const records = parseLines(text).records
    // Sanity: parser dropped the torn line, kept the attach.
    expect(records.length).toBe(1)
    const result = getSessionLiveness(sid, {
      dir,
      hostname: HOST,
      probe: () => "alive",
      readStart: () => "S",
    })
    expect(result.status).toBe("live")
  })
})

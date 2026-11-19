/**
 * `backfillLineage`: links old sub-agent sessions to their lead from the
 * lead transcript or the attach `ppid`. Temp dir only.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { listSessions } from "./session-catalog.ts"
import { readParsedSessionIndex } from "./session-index.ts"
import { backfillLineage, isSubagentSpawnArgv } from "./session-lineage-backfill.ts"
import { indexFilePath, indexMetaFilePath } from "./session-store.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-lineage-backfill-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const HOST = "host-a"
const LEAD = "aaaaaaaa-0000-4000-8000-000000000001"
const LEAD2 = "aaaaaaaa-0000-4000-8000-000000000002"
const FORK = "aaaaaaaa-0000-4000-8000-000000000003"
const C1 = "cccccccc-0000-4000-8000-000000000001"
const C2 = "cccccccc-0000-4000-8000-000000000002"
const C3 = "cccccccc-0000-4000-8000-000000000003"
const C4 = "cccccccc-0000-4000-8000-000000000004"
const USER = "dddddddd-0000-4000-8000-000000000001"

function t(min: number): string {
  return new Date(Date.UTC(2026, 0, 19, 10, min)).toISOString()
}

interface Spec {
  sid: string
  createdMin: number
  pid: number
  ppid: number
  host?: string
  sub?: boolean
  parentSid?: string
  detachMin?: number
  lastMin?: number
  body?: string[]
}

function write(specs: Spec[]): void {
  const index: string[] = []
  for (const s of specs) {
    const argv = s.sub
      ? ["bun", "ma", "--session-id", s.sid, "--output-format", "stream-json", "--prompt", "do it"]
      : ["bun", "ma"]
    index.push(
      JSON.stringify({ sid: s.sid, createdAt: t(s.createdMin), cwd: "/p", model: "m", argv }),
    )
    const recs: unknown[] = [
      {
        kind: "meta",
        formatVersion: 1,
        sid: s.sid,
        createdAt: t(s.createdMin),
        model: "m",
        cwd: "/p",
        systemHash: "",
        toolsHash: "",
        agentVersion: "t",
        ...(s.parentSid ? { parentSid: s.parentSid, forkedAt: t(s.createdMin) } : {}),
      },
      {
        kind: "attach",
        ts: t(s.createdMin),
        pid: s.pid,
        ppid: s.ppid,
        startTime: t(s.createdMin),
        hostname: s.host ?? HOST,
        agentVersion: "t",
      },
      {
        kind: "user",
        ts: t(s.createdMin),
        content: [{ type: "text", text: `hello ${s.sid.slice(0, 8)}` }],
      },
    ]
    const lines = recs.map((r) => JSON.stringify(r))
    for (const b of s.body ?? []) lines.push(b)
    if (s.lastMin !== undefined) {
      lines.push(JSON.stringify({ kind: "note", ts: t(s.lastMin), text: "x" }))
    }
    if (s.detachMin !== undefined) {
      lines.push(JSON.stringify({ kind: "detach", ts: t(s.detachMin), pid: s.pid, reason: "exit" }))
    }
    writeFileSync(join(dir, `${s.sid}.jsonl`), `${lines.join("\n")}\n`)
  }
  writeFileSync(indexFilePath(dir), `${index.join("\n")}\n`)
}

function spawnResult(id: string, role: string, sid: string, min: number): string {
  return JSON.stringify({
    kind: "tool_result",
    ts: t(min),
    content: [
      {
        type: "text",
        text: `Spawned sub-agent ${id} (${role} · m · fresh), running in background as session ${sid}. It works concurrently.`,
      },
    ],
  })
}

describe("isSubagentSpawnArgv", () => {
  test("needs --session-id and --prompt", () => {
    expect(isSubagentSpawnArgv(["ma", "--session-id", "x", "--prompt", "p"])).toBe(true)
    expect(isSubagentSpawnArgv(["ma", "--session-id=x", "--prompt=p"])).toBe(true)
    expect(isSubagentSpawnArgv(["ma", "--prompt", "p"])).toBe(false)
    expect(isSubagentSpawnArgv(["ma", "--session-id", "x"])).toBe(false)
    expect(isSubagentSpawnArgv(undefined)).toBe(false)
  })
})

describe("backfillLineage", () => {
  test("links by transcript and by ppid; skips unknown; dry run writes nothing", () => {
    write([
      {
        sid: LEAD,
        createdMin: 0,
        pid: 100,
        ppid: 1,
        lastMin: 50,
        body: [spawnResult("A1", "worker", C1, 2)],
      },
      { sid: C1, createdMin: 2, pid: 201, ppid: 100, sub: true },
      // ppid match, no transcript text.
      { sid: C2, createdMin: 3, pid: 202, ppid: 100, sub: true },
      // ppid of no known session.
      { sid: C3, createdMin: 4, pid: 203, ppid: 999, sub: true },
      // A normal user session: not a candidate.
      { sid: USER, createdMin: 5, pid: 300, ppid: 100 },
    ])
    const dry = backfillLineage({ dir, dryRun: true })
    expect(dry).toMatchObject({
      candidates: 3,
      linkedByTranscript: 1,
      linkedByPpid: 1,
      ambiguous: 0,
      unknown: 1,
      written: 0,
    })
    expect(dry.links).toEqual([
      { sid: C1, leadSid: LEAD, agentId: "A1", role: "worker", source: "transcript" },
      { sid: C2, leadSid: LEAD, source: "ppid" },
    ])
    expect(() => readFileSync(indexMetaFilePath(dir), "utf8")).toThrow()

    const real = backfillLineage({ dir, now: () => new Date(t(60)) })
    expect(real.written).toBe(2)
    const parsed = readParsedSessionIndex(dir)
    const c1 = parsed.sessions.find((s) => s.sid === C1)
    expect(c1).toMatchObject({ leadSid: LEAD, agentId: "A1", role: "worker" })
    expect(c1?.lineageSource).toBe("transcript")

    // f. Idempotent.
    const again = backfillLineage({ dir })
    expect(again.written).toBe(0)
    expect(again.alreadyLinked).toBe(2)
    const metaLines = readFileSync(indexMetaFilePath(dir), "utf8").trim().split("\n")
    expect(metaLines.filter((l) => l.includes('"lineage"'))).toHaveLength(2)

    // The catalog shows them as children of the lead.
    const list = listSessions({ dir, writeSummaries: false })
    const lead = list.rows.find((r) => r.sid === LEAD)
    expect(lead?.children.map((c) => c.sid)).toEqual([C1, C2])
    expect(list.rows.some((r) => r.sid === C1)).toBe(false)
  })

  test("a child attach outside the lead live window is not linked", () => {
    write([
      { sid: LEAD, createdMin: 0, pid: 100, ppid: 1, detachMin: 5 },
      { sid: C1, createdMin: 10, pid: 201, ppid: 100, sub: true },
    ])
    expect(backfillLineage({ dir, dryRun: true })).toMatchObject({ unknown: 1, linkedByPpid: 0 })
  })

  test("two live leads with the same pid and host: ambiguous; another host does not count", () => {
    write([
      { sid: LEAD, createdMin: 0, pid: 100, ppid: 1, lastMin: 50 },
      { sid: LEAD2, createdMin: 1, pid: 100, ppid: 1, lastMin: 50 },
      { sid: FORK, createdMin: 1, pid: 100, ppid: 1, lastMin: 50, host: "host-b" },
      { sid: C1, createdMin: 2, pid: 201, ppid: 100, sub: true },
    ])
    expect(backfillLineage({ dir, dryRun: true })).toMatchObject({ ambiguous: 1, unknown: 0 })
  })

  test("a fork copy of the lead transcript does not make the link ambiguous", () => {
    write([
      {
        sid: LEAD,
        createdMin: 0,
        pid: 100,
        ppid: 1,
        detachMin: 20,
        body: [spawnResult("A1", "explorer", C1, 2)],
      },
      { sid: C1, createdMin: 2, pid: 201, ppid: 100, sub: true },
      // The fork copies the spawn result; it runs later in another process.
      {
        sid: FORK,
        createdMin: 30,
        pid: 101,
        ppid: 1,
        parentSid: LEAD,
        lastMin: 40,
        body: [spawnResult("A1", "explorer", C1, 2), spawnResult("A2", "worker", C4, 31)],
      },
      { sid: C4, createdMin: 31, pid: 204, ppid: 101, sub: true },
    ])
    const r = backfillLineage({ dir, dryRun: true })
    expect(r.ambiguous).toBe(0)
    expect(r.links).toEqual([
      { sid: C1, leadSid: LEAD, agentId: "A1", role: "explorer", source: "transcript" },
      { sid: C4, leadSid: FORK, agentId: "A2", role: "worker", source: "transcript" },
    ])
  })

  test("recorded lineage is not a candidate; since filters candidates", () => {
    write([
      { sid: LEAD, createdMin: 0, pid: 100, ppid: 1, lastMin: 50 },
      { sid: C1, createdMin: 2, pid: 201, ppid: 100, sub: true },
      { sid: C2, createdMin: 20, pid: 202, ppid: 100, sub: true },
    ])
    const text = readFileSync(indexFilePath(dir), "utf8").replace(
      `"sid":"${C1}",`,
      `"sid":"${C1}","leadSid":"${LEAD}",`,
    )
    writeFileSync(indexFilePath(dir), text)
    expect(backfillLineage({ dir, dryRun: true }).candidates).toBe(1)
    expect(backfillLineage({ dir, dryRun: true, since: t(30) }).candidates).toBe(0)
    expect(() => backfillLineage({ dir, since: "bad" })).toThrow(RangeError)
  })
})

/**
 * Sidecar `kind: "lineage"` lines (backfilled lead links of old sub-agent
 * sessions): the reader merges them only when the session line has no
 * recorded `leadSid`, and tombstones remove them.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { defaultSessionCatalogIo, listSessions, type SessionCatalogIo } from "./session-catalog.ts"
import { parseSessionIndexText } from "./session-index.ts"
import { indexFilePath, indexMetaFilePath } from "./session-store.ts"

const SID = "ba0ad20f-0000-4000-8000-000000000001"
const LEAD = "d17b0257-0000-4000-8000-000000000002"
const OTHER = "f730cc8c-0000-4000-8000-000000000003"

function session(sid: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sid,
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/p",
    model: "m",
    ...extra,
  })
}

function lineage(sid: string, leadSid: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "lineage",
    v: 1,
    sid,
    leadSid,
    source: "transcript",
    at: "2026-01-02T00:00:00.000Z",
    ...extra,
  })
}

describe("lineage sidecar lines", () => {
  test("fill leadSid, agentId, role and lineageSource when the line has none", () => {
    const parsed = parseSessionIndexText(
      `${session(SID)}\n`,
      `${lineage(SID, LEAD, { agentId: "A1", role: "worker" })}\n`,
    )
    expect(parsed.sessions[0]).toMatchObject({
      sid: SID,
      leadSid: LEAD,
      agentId: "A1",
      role: "worker",
      lineageSource: "transcript",
    })
    expect(parsed.lineages.get(SID)?.leadSid).toBe(LEAD)
  })

  test("recorded lineage wins", () => {
    const parsed = parseSessionIndexText(
      `${session(SID, { leadSid: OTHER, agentId: "A9" })}\n`,
      `${lineage(SID, LEAD, { agentId: "A1" })}\n`,
    )
    expect(parsed.sessions[0]?.leadSid).toBe(OTHER)
    expect(parsed.sessions[0]?.agentId).toBe("A9")
    expect(parsed.sessions[0]?.lineageSource).toBeUndefined()
  })

  test("the last lineage line of a sid wins", () => {
    const parsed = parseSessionIndexText(
      `${session(SID)}\n`,
      `${lineage(SID, OTHER, { source: "ppid" })}\n${lineage(SID, LEAD)}\n`,
    )
    expect(parsed.sessions[0]?.leadSid).toBe(LEAD)
    expect(parsed.sessions[0]?.lineageSource).toBe("transcript")
  })

  test("a later sidecar tombstone removes the lineage line", () => {
    const tomb = JSON.stringify({ kind: "tombstone", sid: SID, at: "x", indexBytes: 10_000 })
    const text = `${session(SID)}\n`
    const parsed = parseSessionIndexText(text, `${lineage(SID, LEAD)}\n${tomb}\n`)
    // indexBytes past the line: the session line is cut too.
    expect(parsed.sessions).toEqual([])
    expect(parsed.lineages.size).toBe(0)
    // A lineage line after the tombstone is kept.
    const reused = parseSessionIndexText(
      text,
      `${JSON.stringify({ kind: "tombstone", sid: SID, at: "x", indexBytes: 0 })}\n${lineage(SID, LEAD)}\n`,
    )
    expect(reused.sessions[0]?.leadSid).toBe(LEAD)
  })

  test("bad lineage lines are skipped; a lineage line in index.jsonl is not a session", () => {
    const bad = [
      lineage(SID, SID),
      lineage(SID, ""),
      lineage(SID, LEAD, { source: "guess" }),
      JSON.stringify({ kind: "lineage", sid: SID }),
    ].join("\n")
    const parsed = parseSessionIndexText(`${session(SID)}\n${lineage(OTHER, LEAD)}\n`, `${bad}\n`)
    expect(parsed.sessions.map((s) => s.sid)).toEqual([SID])
    expect(parsed.sessions[0]?.leadSid).toBeUndefined()
    expect(parsed.lineages.size).toBe(0)
  })
})

describe("catalog rows: lineageSource and forkOf", () => {
  test("inferred child under its lead; recorded source; fork is a top row with forkOf", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-lineage-catalog-"))
    try {
      const FORK = "44444444-0000-4000-8000-000000000004"
      const REC = "c7c11b04-0000-4000-8000-000000000005"
      const meta = (sid: string, parentSid?: string): string =>
        JSON.stringify({
          kind: "meta",
          formatVersion: 1,
          sid,
          createdAt: "2026-01-01T00:00:00.000Z",
          model: "m",
          cwd: "/p",
          systemHash: "",
          toolsHash: "",
          agentVersion: "t",
          ...(parentSid ? { parentSid, forkedAt: "2026-01-01T00:00:00.000Z" } : {}),
        })
      for (const [sid, parent] of [
        [LEAD, undefined],
        [SID, undefined],
        [REC, undefined],
        [FORK, LEAD],
      ] as const) {
        writeFileSync(join(dir, `${sid}.jsonl`), `${meta(sid, parent)}\n`)
      }
      writeFileSync(
        indexFilePath(dir),
        [
          session(LEAD),
          session(SID, { createdAt: "2026-01-01T00:01:00.000Z" }),
          session(REC, { leadSid: LEAD, createdAt: "2026-01-01T00:02:00.000Z" }),
          session(FORK, { createdAt: "2026-01-01T01:00:00.000Z" }),
        ].join("\n"),
      )
      const summary = (sid: string): string =>
        JSON.stringify({
          kind: "summary",
          v: 3,
          sid,
          title: `t ${sid.slice(0, 2)}`,
          tokens: 1,
          estimated: false,
          turns: 1,
          endedAt: "2026-01-01T00:00:00.000Z",
          status: "done",
        })
      writeFileSync(
        indexMetaFilePath(dir),
        `${[summary(LEAD), summary(SID), summary(REC), summary(FORK), lineage(SID, LEAD)].join("\n")}\n`,
      )
      let heads = 0
      const io: SessionCatalogIo = {
        ...defaultSessionCatalogIo,
        stat: undefined,
        readHead: (path, bytes) => {
          heads += 1
          return defaultSessionCatalogIo.readHead?.(path, bytes) ?? ""
        },
      }
      const res = listSessions({ dir, writeSummaries: false, io })
      expect(res.rows.map((r) => r.sid)).toEqual([FORK, LEAD])
      const lead = res.rows[1]
      expect(lead?.forkOf).toBeUndefined()
      expect(lead?.lineageSource).toBeUndefined()
      expect(lead?.children.map((c) => [c.sid, c.lineageSource])).toEqual([
        [SID, "transcript"],
        [REC, "recorded"],
      ])
      expect(res.rows[0]?.forkOf).toBe(LEAD)
      // One head read per returned row (2 tops + 2 children), no more.
      expect(heads).toBe(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

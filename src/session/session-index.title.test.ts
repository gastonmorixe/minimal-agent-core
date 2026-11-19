/**
 * C9: the session index reader and the catalog merge the sidecar title
 * lines (title plugin SPEC §9.1-9.2). All files are in a temp dir; the
 * default sessions dir is a temp `MINIMAL_AGENT_HOME`.
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { createSessionsReadApi } from "../plugins/host/providers/sessions-read.ts"

import { defaultSessionCatalogIo, listSessions, type SessionCatalogIo } from "./session-catalog.ts"
import { parseSessionIndexText, readParsedSessionIndex } from "./session-index.ts"
import { indexFilePath, indexMetaFilePath, sessionFilePath } from "./session-store.ts"
import { INDEX_TITLE_VERSION, type IndexTitleRecord } from "./session-title.ts"

let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-index-title-"))
  prevHome = process.env.MINIMAL_AGENT_HOME
  process.env.MINIMAL_AGENT_HOME = join(dir, ".minimal-agent")
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = prevHome
  rmSync(dir, { recursive: true, force: true })
})

const lines = (...rs: unknown[]): string => `${rs.map((r) => JSON.stringify(r)).join("\n")}\n`

/** A UUID-like sid from a number. */
function sidOf(n: number): string {
  return `bbbbbbbb-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
}

/** A fixed time in the past (no live or stale rule depends on the clock). */
function iso(minute: number): string {
  return new Date(Date.UTC(2026, 0, 19, 0, minute)).toISOString()
}

function session(sid: string, minute = 0, extra: Record<string, unknown> = {}) {
  return { sid, createdAt: iso(minute), cwd: "/w", model: "m", ...extra }
}

function summary(sid: string, title: string, minute = 0) {
  return {
    kind: "summary",
    v: 3,
    sid,
    title,
    tokens: 10,
    estimated: false,
    turns: 2,
    endedAt: iso(minute + 1),
    status: "done",
  }
}

function title(
  sid: string,
  source: IndexTitleRecord["source"],
  text: string,
  over: Partial<IndexTitleRecord> = {},
): IndexTitleRecord {
  return {
    kind: "title",
    v: INDEX_TITLE_VERSION,
    sid,
    title: text,
    source,
    at: "2026-11-19T14:00:00.000Z",
    ...over,
  }
}

/** Write the two index files and an empty-ish session file for each sid (mtime = its summary end). */
function seed(index: unknown[], meta: unknown[], files: { sid: string; minute: number }[]): void {
  writeFileSync(indexFilePath(dir), lines(...index))
  writeFileSync(indexMetaFilePath(dir), meta.length > 0 ? lines(...meta) : "")
  for (const f of files) {
    const path = sessionFilePath(f.sid, dir)
    writeFileSync(path, "{}\n")
    const t = new Date(iso(f.minute + 1))
    utimesSync(path, t, t)
  }
}

const dead = { probe: () => "dead" as const, readStart: () => null }

/** An io that records each file read (also the two index files). */
function countingIo(): SessionCatalogIo & { reads: string[] } {
  const io = {
    ...defaultSessionCatalogIo,
    reads: [] as string[],
    readFile(path: string): string {
      io.reads.push(path)
      return defaultSessionCatalogIo.readFile(path)
    },
  }
  return io
}

// ---------------------------------------------------------------------------
// Reader merge (SPEC §9.1)
// ---------------------------------------------------------------------------

describe("parseSessionIndexText titles", () => {
  test("each source is kept; the last line wins per (sid, source)", () => {
    const index = lines(session("s1"), session("s2"))
    const meta = lines(
      title("s1", "ai", "First ai"),
      title("s1", "derived", "A1 worker"),
      title("s2", "ai", "Other sid"),
      title("s1", "ai", "Second ai"),
      title("s1", "user", "Mine"),
    )
    const { titles } = parseSessionIndexText(index, meta)
    expect(titles.get("s1")?.ai?.title).toBe("Second ai")
    expect(titles.get("s1")?.user?.title).toBe("Mine")
    expect(titles.get("s1")?.derived?.title).toBe("A1 worker")
    expect(titles.get("s2")?.ai?.title).toBe("Other sid")
    expect(titles.get("s2")?.user).toBeUndefined()
  })

  test("a last empty user line means no user title; an earlier one is replaced", () => {
    const index = lines(session("s1"), session("s2"))
    const meta = lines(
      title("s1", "user", "Mine"),
      title("s1", "ai", "Ai one"),
      title("s1", "user", ""),
      title("s2", "user", ""),
      title("s2", "user", "Back"),
    )
    const { titles } = parseSessionIndexText(index, meta)
    expect(titles.get("s1")?.user).toBeUndefined()
    expect(titles.get("s1")?.ai?.title).toBe("Ai one")
    expect(titles.get("s2")?.user?.title).toBe("Back")
  })

  test("a sid with only an empty user line has no entry", () => {
    const { titles } = parseSessionIndexText(lines(session("s1")), lines(title("s1", "user", "")))
    expect(titles.has("s1")).toBe(false)
  })

  test("an unknown v, a bad line and other kinds are skipped", () => {
    const meta = `${lines(
      { ...title("s1", "ai", "Future"), v: 2 },
      { kind: "title", sid: "s1", title: 7, source: "ai", v: 1, at: "t" },
      title("s1", "ai", "Known"),
      { ...title("s1", "user", "Future user"), v: 9 },
    )}not json\n`
    const { titles } = parseSessionIndexText(lines(session("s1")), meta)
    expect(titles.get("s1")).toEqual({ ai: title("s1", "ai", "Known") })
  })

  test("rule 1: a sidecar tombstone cuts the earlier title lines of its sid only", () => {
    const index = lines(session("s1"), session("s2"))
    const meta = lines(
      title("s1", "user", "Old user"),
      title("s1", "ai", "Old ai"),
      title("s2", "ai", "Kept"),
      { kind: "tombstone", sid: "s1", at: iso(5) },
      title("s1", "ai", "New ai"),
    )
    const { titles } = parseSessionIndexText(index, meta)
    expect(titles.get("s1")).toEqual({ ai: title("s1", "ai", "New ai") })
    expect(titles.get("s2")?.ai?.title).toBe("Kept")
  })

  test("rule 1: a tombstone after all title lines of a sid removes the entry", () => {
    const meta = lines(title("s1", "ai", "Gone"), { kind: "tombstone", sid: "s1", at: iso(5) })
    expect(parseSessionIndexText(lines(session("s1")), meta).titles.has("s1")).toBe(false)
  })

  test("rule 2: an index.jsonl tombstone with no later session line drops the titles", () => {
    const meta = lines(title("s1", "ai", "Gone"), title("s2", "ai", "Reused"))
    const index = lines(
      session("s1"),
      session("s2"),
      { kind: "tombstone", sid: "s1" },
      { kind: "tombstone", sid: "s2" },
      session("s2", 9),
    )
    const { titles, sessions } = parseSessionIndexText(index, meta)
    expect(titles.has("s1")).toBe(false)
    expect(titles.get("s2")?.ai?.title).toBe("Reused")
    expect(sessions.map((s) => s.sid)).toEqual(["s2"])
  })

  test("title lines do not change sessions, summaries or lineage", () => {
    const index = lines(session("s1"), session("c1", 1, { leadSid: "s1" }), session("c2", 2))
    const meta = lines(summary("s1", "first prompt"), {
      kind: "lineage",
      v: 1,
      sid: "c2",
      leadSid: "s1",
      source: "ppid",
      at: iso(3),
    })
    const base = parseSessionIndexText(index, meta)
    const withTitles = parseSessionIndexText(
      index,
      `${meta}${lines(title("s1", "ai", "T"), title("c2", "derived", "W"))}`,
    )
    expect(withTitles.sessions).toEqual(base.sessions)
    expect(withTitles.summaries).toEqual(base.summaries)
    expect(withTitles.lineages).toEqual(base.lineages)
    expect(base.titles.size).toBe(0)
    expect(withTitles.titles.size).toBe(2)
  })

  test("readParsedSessionIndex carries the titles from the sidecar file", () => {
    seed([session("s1")], [title("s1", "ai", "From file")], [])
    expect(readParsedSessionIndex(dir).titles.get("s1")?.ai?.title).toBe("From file")
  })
})

// ---------------------------------------------------------------------------
// Catalog row (SPEC §9.2)
// ---------------------------------------------------------------------------

describe("listSessions titles", () => {
  test("row title by display order user > ai > derived; summary.title stays the prompt", () => {
    const sids = ["u", "a", "d", "p"].map((p, i) => ({ sid: `${p}-sid`, minute: i * 10 }))
    seed(
      sids.map((s) => session(s.sid, s.minute)),
      [
        ...sids.map((s) => summary(s.sid, `prompt of ${s.sid}`, s.minute)),
        title("u-sid", "ai", "Ai loses"),
        title("u-sid", "user", "User wins"),
        title("u-sid", "derived", "Derived loses"),
        title("a-sid", "derived", "Derived loses"),
        title("a-sid", "ai", "Ai wins"),
        title("a-sid", "user", ""),
        title("d-sid", "derived", "Derived wins"),
      ],
      sids,
    )
    const out = listSessions({ dir, writeSummaries: false, liveness: dead })
    const view = Object.fromEntries(
      out.rows.map((r) => [r.sid, [r.title, r.titleSource, r.summary?.title]]),
    )
    expect(view).toEqual({
      "u-sid": ["User wins", "user", "prompt of u-sid"],
      "a-sid": ["Ai wins", "ai", "prompt of a-sid"],
      "d-sid": ["Derived wins", "derived", "prompt of d-sid"],
      "p-sid": [undefined, undefined, "prompt of p-sid"],
    })
    // Display order with the first-prompt fallback.
    expect(out.rows.map((r) => r.title ?? r.summary?.title)).toEqual([
      "prompt of p-sid",
      "Derived wins",
      "Ai wins",
      "User wins",
    ])
  })

  test("a row with no title line has no title fields (old summary-only rows unchanged)", () => {
    seed([session("s1")], [summary("s1", "prompt")], [{ sid: "s1", minute: 0 }])
    const row = listSessions({ dir, writeSummaries: false, liveness: dead }).rows[0]
    expect("title" in row).toBe(false)
    expect("titleSource" in row).toBe(false)
    expect(row.summary?.title).toBe("prompt")
  })

  test("a child row gets its own title", () => {
    seed(
      [session("lead"), session("kid", 1, { leadSid: "lead", agentId: "A1", role: "worker" })],
      [
        summary("lead", "lead prompt"),
        summary("kid", "kid prompt", 1),
        title("kid", "derived", "A1 worker"),
      ],
      [
        { sid: "lead", minute: 0 },
        { sid: "kid", minute: 1 },
      ],
    )
    const out = listSessions({ dir, writeSummaries: false, liveness: dead })
    expect(out.rows[0].title).toBeUndefined()
    expect(out.rows[0].children[0].title).toBe("A1 worker")
    expect(out.rows[0].children[0].titleSource).toBe("derived")
  })

  test("query matches the saved title with no session-file read", () => {
    seed(
      [session("s1"), session("s2", 5)],
      [summary("s1", "first prompt"), title("s1", "ai", "Fix the Flaky catalog test")],
      [
        { sid: "s1", minute: 0 },
        { sid: "s2", minute: 5 },
      ],
    )
    const io = countingIo()
    // s2 has no summary line: a non-matching row is not read.
    const out = listSessions({ dir, io, writeSummaries: false, liveness: dead, query: "flaky" })
    expect(out.rows.map((r) => r.sid)).toEqual(["s1"])
    expect(out.total).toBe(1)
    expect(io.reads.some((p) => p.endsWith("s2.jsonl"))).toBe(false)
  })

  test("query matches the title shown, not a title that a user title hides", () => {
    seed(
      [session("s1")],
      [summary("s1", "prompt"), title("s1", "ai", "hidden ai"), title("s1", "user", "shown")],
      [{ sid: "s1", minute: 0 }],
    )
    const q = (query: string) =>
      listSessions({ dir, writeSummaries: false, liveness: dead, query }).rows.length
    expect(q("shown")).toBe(1)
    expect(q("hidden")).toBe(0)
    expect(q("prompt")).toBe(1)
  })

  test("a title line does not change the hidden rule, counts or liveness", () => {
    const index = [session("s1"), session("e1", 1)]
    const meta = [summary("s1", "p"), { ...summary("e1", "", 1), turns: 0 }]
    const files = [
      { sid: "s1", minute: 0 },
      { sid: "e1", minute: 1 },
    ]
    seed(index, meta, files)
    const strip = (o: ReturnType<typeof listSessions>) => ({
      ...o,
      rows: o.rows.map(({ title: _t, titleSource: _s, ...r }) => r),
    })
    const opts = { dir, writeSummaries: false, liveness: dead, includeHidden: true }
    const before = listSessions(opts)
    seed(index, [...meta, title("s1", "ai", "T1"), title("e1", "user", "T2")], files)
    const after = listSessions(opts)
    expect(strip(after)).toEqual(before)
    expect(after.rows.find((r) => r.sid === "e1")?.hiddenReason).toBe("empty")
    expect(after.hiddenCount).toBe(before.hiddenCount)
    expect(after.rows.find((r) => r.sid === "e1")?.title).toBe("T2")
  })

  test("a tombstoned sid gets no title; a re-used sid gets the later line", () => {
    seed(
      [session("s1")],
      [
        title("s1", "user", "Old"),
        { kind: "tombstone", sid: "s1", at: iso(2), indexBytes: 0 },
        summary("s1", "p"),
        title("s1", "ai", "New"),
      ],
      [{ sid: "s1", minute: 0 }],
    )
    const row = listSessions({ dir, writeSummaries: false, liveness: dead }).rows[0]
    expect(row.title).toBe("New")
    expect(row.titleSource).toBe("ai")
  })
})

// ---------------------------------------------------------------------------
// sessions:read
// ---------------------------------------------------------------------------

describe("sessions:read list query", () => {
  test("matches the saved title", async () => {
    seed(
      [session("s1"), session("s2", 5)],
      [title("s2", "user", "Release notes")],
      [
        { sid: "s1", minute: 0 },
        { sid: "s2", minute: 5 },
      ],
    )
    const api = createSessionsReadApi({ dir })
    const hit = await api.list({ query: "release" })
    expect(hit.items.map((i) => i.sid)).toEqual(["s2"])
    expect((await api.list({ query: "nothing" })).total).toBe(0)
    expect((await api.list()).total).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe("titles performance", () => {
  test("20k index lines + 5k title lines: parse and list stay under 200 ms", () => {
    const N = 20_000
    const index: string[] = []
    const meta: string[] = []
    for (let i = 0; i < N; i++) {
      const sid = sidOf(i)
      index.push(JSON.stringify(session(sid, i)))
      meta.push(JSON.stringify(summary(sid, `task number ${i}`, i)))
    }
    for (let i = 0; i < 5_000; i++) {
      const sid = sidOf(N - 1 - (i % 4_000))
      meta.push(JSON.stringify(title(sid, i % 3 === 0 ? "user" : "ai", `title ${i}`)))
    }
    writeFileSync(indexFilePath(dir), `${index.join("\n")}\n`)
    writeFileSync(indexMetaFilePath(dir), `${meta.join("\n")}\n`)
    for (let i = N - 40; i < N; i++) {
      const path = sessionFilePath(sidOf(i), dir)
      writeFileSync(path, "{}\n")
      const t = new Date(iso(i + 1))
      utimesSync(path, t, t)
    }
    const io = countingIo()
    listSessions({ dir, io, writeSummaries: false, liveness: dead }) // warm up the JIT
    io.reads.length = 0
    const t0 = performance.now()
    const out = listSessions({ dir, io, writeSummaries: false, liveness: dead })
    const ms = performance.now() - t0
    expect(out.rows).toHaveLength(30)
    expect(out.rows[0].title).toBeDefined()
    // Only the two index files: no extra read for titles.
    expect(io.reads).toEqual([indexFilePath(dir), indexMetaFilePath(dir)])
    expect(ms).toBeLessThan(200)
  })
})

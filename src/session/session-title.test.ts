import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { fixtureSidebandOrNone } from "../test-utils/sideband-fixture.ts"

import { listSessions } from "./session-catalog.ts"
import { parseSessionIndexText, readParsedSessionIndex, readSessionIndex } from "./session-index.ts"
import { type IndexRecord, indexFilePath, indexMetaFilePath } from "./session-store.ts"
import {
  appendIndexMeta,
  INDEX_TITLE_VERSION,
  type IndexTitleRecord,
  isIndexTitleRecord,
  parseTitleState,
  readTitleState,
  sanitizeTitle,
  TITLE_ID_MAX_CHARS,
  TITLE_MAX_CHARS,
} from "./session-title.ts"

const SB = fixtureSidebandOrNone()

let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-title-"))
  prevHome = process.env.MINIMAL_AGENT_HOME
  process.env.MINIMAL_AGENT_HOME = join(dir, ".minimal-agent")
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = prevHome
  rmSync(dir, { recursive: true, force: true })
})

function rec(over: Partial<IndexTitleRecord> = {}): IndexTitleRecord {
  return {
    kind: "title",
    v: INDEX_TITLE_VERSION,
    sid: "s1",
    title: "Fix the login bug",
    source: "ai",
    at: "2026-11-19T14:00:00.000Z",
    ...over,
  }
}

const lines = (...rs: unknown[]): string => `${rs.map((r) => JSON.stringify(r)).join("\n")}\n`

describe("isIndexTitleRecord", () => {
  test("accepts a valid line, with and without optional fields", () => {
    expect(isIndexTitleRecord(rec())).toBe(true)
    expect(
      isIndexTitleRecord(
        rec({
          model: "utility-model-1",
          provider: "provider-a",
          usage: { inputTokens: 800, outputTokens: 30, costUsd: 0.0001 },
        }),
      ),
    ).toBe(true)
    expect(isIndexTitleRecord(rec({ source: "user", title: "" }))).toBe(true)
  })

  test("rejects other kinds, bad fields, unknown versions", () => {
    expect(isIndexTitleRecord(null)).toBe(false)
    expect(isIndexTitleRecord("x")).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), kind: "summary" })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), v: 2 })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), v: 0 })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), v: 1.5 })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), v: undefined })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), sid: "" })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), sid: 3 })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), source: "model" })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), title: 5 })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), title: "x".repeat(TITLE_MAX_CHARS + 1) })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), at: undefined })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), model: 1 })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), usage: { inputTokens: "1", outputTokens: 2 } })).toBe(
      false,
    )
  })

  test("A3/B1: rejects non-finite or negative usage and model/provider over 128 chars", () => {
    const u = (over: Record<string, number>) => ({ inputTokens: 1, outputTokens: 2, ...over })
    expect(isIndexTitleRecord({ ...rec(), usage: u({ costUsd: Number.NaN }) })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), usage: u({ inputTokens: Infinity }) })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), usage: u({ outputTokens: -1 }) })).toBe(false)
    expect(isIndexTitleRecord({ ...rec(), usage: u({ costUsd: 0 }) })).toBe(true)
    expect(isIndexTitleRecord(rec({ model: "m".repeat(TITLE_ID_MAX_CHARS) }))).toBe(true)
    expect(isIndexTitleRecord(rec({ model: "m".repeat(TITLE_ID_MAX_CHARS + 1) }))).toBe(false)
    expect(isIndexTitleRecord(rec({ provider: "p".repeat(TITLE_ID_MAX_CHARS + 1) }))).toBe(false)
  })
})

describe("sanitizeTitle", () => {
  test("control chars, collapse, trim", () => {
    expect(sanitizeTitle("  Fix\tthe\n\nlogin\u0000 bug\u2028 ")).toBe("Fix the login bug")
    expect(sanitizeTitle("a\u001b[31mb")).toBe("a [31mb")
  })

  test("removes one pair of outer quotes", () => {
    expect(sanitizeTitle('"Fix bug"')).toBe("Fix bug")
    expect(sanitizeTitle("\u201cFix bug\u201d")).toBe("Fix bug")
    expect(sanitizeTitle("'Fix bug'")).toBe("Fix bug")
    expect(sanitizeTitle('"Fix" bug')).toBe('"Fix" bug')
  })

  test("caps at 80 code points", () => {
    expect(sanitizeTitle("x".repeat(200)).length).toBe(TITLE_MAX_CHARS)
    const emoji = "😀".repeat(100)
    const out = sanitizeTitle(emoji)
    expect(Array.from(out).length).toBe(TITLE_MAX_CHARS)
    expect(isIndexTitleRecord(rec({ title: out }))).toBe(true)
    // A cut that ends in a space is trimmed.
    expect(sanitizeTitle(`${"a".repeat(79)} bbbb`)).toBe("a".repeat(79))
  })

  test("removes <ma::…> tags", () => {
    expect(sanitizeTitle('Fix<ma::emit::diff a="1"/>the bug', SB)).toBe("Fix the bug")
    expect(sanitizeTitle("<ma::x>Fix bug</ma::x>", SB)).toBe("Fix bug")
    expect(sanitizeTitle("Fix bug <ma::agent::raw-output path=", SB)).toBe("Fix bug")
    expect(sanitizeTitle("<ma::x/>", SB)).toBe("")
    expect(sanitizeTitle("a < b and <map>", SB)).toBe("a < b and <map>")
  })

  test("B2: removes bidi override, bidi isolate, zero-width and BOM chars", () => {
    expect(sanitizeTitle("abc\u202Edef\u200B")).toBe("abcdef")
    expect(sanitizeTitle("\uFEFFa\u202Ab\u202Bc\u202Cd\u202De")).toBe("abcde")
    expect(sanitizeTitle("a\u2066b\u2067c\u2068d\u2069e")).toBe("abcde")
    expect(sanitizeTitle("a\u200Bb\u200Cc\u200Dd\u200Ee\u200Ff")).toBe("abcdef")
    expect(sanitizeTitle("\u202E\u200B")).toBe("")
  })

  test("empty or blank input gives an empty string", () => {
    expect(sanitizeTitle("")).toBe("")
    expect(sanitizeTitle(" \n\t\u0000 ")).toBe("")
    expect(sanitizeTitle('""')).toBe("")
  })
})

describe("appendIndexMeta", () => {
  test("appends exactly one line per call to index-meta.jsonl", () => {
    expect(appendIndexMeta(rec(), dir)).toBe(true)
    expect(appendIndexMeta(rec({ title: "Second" }), dir)).toBe(true)
    const text = readFileSync(indexMetaFilePath(dir), "utf-8")
    const parts = text.split("\n")
    expect(parts.length).toBe(3)
    expect(parts[2]).toBe("")
    expect(JSON.parse(parts[0])).toEqual(rec())
    expect(JSON.parse(parts[1]).title).toBe("Second")
  })

  test("keeps the earlier lines of other kinds", () => {
    writeFileSync(indexMetaFilePath(dir), lines({ kind: "tombstone", sid: "x", at: "t" }))
    appendIndexMeta(rec(), dir)
    const parts = readFileSync(indexMetaFilePath(dir), "utf-8").trimEnd().split("\n")
    expect(parts.map((p) => JSON.parse(p).kind)).toEqual(["tombstone", "title"])
  })

  test("never throws: a missing dir gives false", () => {
    expect(appendIndexMeta(rec(), join(dir, "no", "such"))).toBe(false)
  })

  test("default dir comes from MINIMAL_AGENT_HOME", () => {
    const home = process.env.MINIMAL_AGENT_HOME ?? ""
    const sessions = join(home, "sessions")
    mkdirSync(sessions, { recursive: true })
    expect(appendIndexMeta(rec())).toBe(true)
    expect(existsSync(indexMetaFilePath(sessions))).toBe(true)
    expect(readTitleState("s1").ai?.title).toBe("Fix the login bug")
  })

  test("two processes append at the same time: each line parses", async () => {
    const mod = join(import.meta.dir, "session-title.ts")
    const script = (tag: string): string =>
      `const m = await import(${JSON.stringify(mod)});` +
      `for (let i = 0; i < 200; i++) m.appendIndexMeta({kind:"title",v:1,sid:"${tag}"+i,` +
      `title:"T".repeat(80),source:"ai",at:new Date().toISOString(),model:"m".repeat(120),provider:"p".repeat(120)}, ${JSON.stringify(dir)});`
    const procs = ["a", "b"].map((tag) =>
      Bun.spawn([process.execPath, "-e", script(tag)], { stdout: "ignore", stderr: "inherit" }),
    )
    const codes = await Promise.all(procs.map((p) => p.exited))
    expect(codes).toEqual([0, 0])
    const parts = readFileSync(indexMetaFilePath(dir), "utf-8").trimEnd().split("\n")
    expect(parts.length).toBe(400)
    for (const p of parts) expect(isIndexTitleRecord(JSON.parse(p))).toBe(true)
  }, 30_000)
})

describe("parseTitleState / readTitleState", () => {
  test("last line wins per source", () => {
    const text = lines(
      rec({ title: "One" }),
      rec({ title: "Mine", source: "user" }),
      rec({ title: "Two" }),
      rec({ sid: "s2", title: "Other" }),
    )
    const st = parseTitleState("s1", text)
    expect(st.ai?.title).toBe("Two")
    expect(st.user?.title).toBe("Mine")
    expect(st.derived).toBeUndefined()
  })

  test("a tombstone removes the earlier lines of its sid only", () => {
    const text = lines(
      rec({ title: "Old" }),
      rec({ sid: "s2", title: "Keep" }),
      { kind: "tombstone", sid: "s1", at: "t" },
      rec({ source: "user", title: "New" }),
    )
    const st = parseTitleState("s1", text)
    expect(st.ai).toBeUndefined()
    expect(st.user?.title).toBe("New")
    expect(parseTitleState("s2", text).ai?.title).toBe("Keep")
  })

  test("an empty user line means no user title", () => {
    const text = lines(rec({ source: "user", title: "Mine" }), rec({ source: "user", title: "" }))
    expect(parseTitleState("s1", text).user).toBeUndefined()
    const again = `${text}${lines(rec({ source: "user", title: "Back" }))}`
    expect(parseTitleState("s1", again).user?.title).toBe("Back")
  })

  test("ignores v>1, bad JSON and other kinds", () => {
    const text = `${lines(rec({ title: "Good" }), { ...rec({ title: "Future" }), v: 2 })}{bad\n${lines(
      { kind: "summary", sid: "s1", title: "x" },
    )}`
    expect(parseTitleState("s1", text).ai?.title).toBe("Good")
  })

  test("missing file gives {}", () => {
    expect(readTitleState("s1", dir)).toEqual({})
  })
})

describe("old readers ignore title lines", () => {
  // Copy of the HEAD `readSessionIndex` parse loop (git show HEAD:src/session/session-index.ts).
  // It reads only `index.jsonl`; title lines go only to `index-meta.jsonl`.
  function headReadSessionIndex(d: string): IndexRecord[] {
    let text: string
    try {
      text = readFileSync(indexFilePath(d), "utf-8")
    } catch {
      return []
    }
    const out: IndexRecord[] = []
    for (const line of text.split("\n")) {
      if (line.length === 0) continue
      try {
        const r = JSON.parse(line) as IndexRecord
        if (!existsSync(join(d, `${r.sid}.jsonl`))) continue
        out.push(r)
      } catch {
        // Skip malformed lines.
      }
    }
    return out
  }

  const session: IndexRecord = {
    sid: "s1",
    createdAt: "2026-11-19T13:00:00.000Z",
    cwd: "/w",
    model: "m",
  }

  test("the HEAD reader sees the same rows with and without title lines", () => {
    writeFileSync(indexFilePath(dir), lines(session))
    writeFileSync(join(dir, "s1.jsonl"), "")
    const before = headReadSessionIndex(dir)
    appendIndexMeta(rec(), dir)
    appendIndexMeta(rec({ source: "user", title: "Mine" }), dir)
    expect(headReadSessionIndex(dir)).toEqual(before)
    expect(before.map((r) => r.sid)).toEqual(["s1"])
  })

  test("append never writes index.jsonl", () => {
    writeFileSync(indexFilePath(dir), lines(session))
    const before = readFileSync(indexFilePath(dir), "utf-8")
    appendIndexMeta(rec(), dir)
    expect(readFileSync(indexFilePath(dir), "utf-8")).toBe(before)
  })

  test("the current readers give no row and no crash for title lines", () => {
    const sessions = join(process.env.MINIMAL_AGENT_HOME ?? "", "sessions")
    mkdirSync(sessions, { recursive: true })
    writeFileSync(indexFilePath(sessions), lines(session))
    writeFileSync(join(sessions, "s1.jsonl"), "")
    const noLive = { probe: () => "dead" as const, readStart: () => null }
    const list = () => listSessions({ dir: sessions, writeSummaries: false, liveness: noLive })
    const before = {
      index: readSessionIndex(),
      parsed: readParsedSessionIndex(sessions),
      list: list(),
    }
    // A title line of a sid with no session line, a valid one, a future one, and a bad one.
    appendIndexMeta(rec({ sid: "ghost" }), sessions)
    appendIndexMeta(rec(), sessions)
    const future = { ...rec(), v: 9 }
    appendIndexMeta(future, sessions)
    appendIndexMeta({ kind: "title", sid: 7 } as unknown as IndexTitleRecord, sessions)
    expect(readSessionIndex()).toEqual(before.index)
    // Title lines give no row and do not change sessions/summaries/lineage.
    // The parsed index carries the title state on purpose (C9).
    const { titles, ...parsed } = readParsedSessionIndex(sessions)
    const { titles: _none, ...beforeParsed } = before.parsed
    expect(parsed).toEqual(beforeParsed)
    expect(titles.get("s1")?.ai?.title).toBe(rec().title)
    const after = list()
    const rows = after.rows.map(({ title: _t, titleSource: _s, ...r }) => r)
    expect({ ...after, rows }).toEqual(before.list)
    expect(before.index.map((r) => r.sid)).toEqual(["s1"])
  })

  test("the current parser does not change with title lines in the sidecar", () => {
    const index = lines(session)
    const meta = lines({ kind: "tombstone", sid: "zz", at: "t" })
    const base = parseSessionIndexText(index, meta)
    const withTitles = parseSessionIndexText(
      index,
      `${meta}${lines(rec(), rec({ source: "user", title: "Mine" }), { ...rec(), v: 9 })}`,
    )
    // Title lines do not change sessions/summaries/lineage. Only `titles` changes (C9).
    expect({ ...withTitles, titles: base.titles }).toEqual(base)
    expect(base.titles.size).toBe(0)
    expect(withTitles.titles.get("s1")?.user?.title).toBe("Mine")
  })
})

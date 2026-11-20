import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { perfBudgetMs } from "../test-utils/perf-budget.ts"

import { defaultSessionCatalogIo, listSessions, type SessionCatalogIo } from "./session-catalog.ts"
import { parseSessionIndexText, readParsedSessionIndex, readSessionIndex } from "./session-index.ts"
import {
  type IndexRecord,
  type IndexSummaryRecord,
  indexFilePath,
  indexMetaFilePath,
  isPinnedSubagentSid,
  SessionStore,
  sessionFilePath,
} from "./session-store.ts"

// ---------------------------------------------------------------------------
// Helpers: an isolated sessions dir per test.
// ---------------------------------------------------------------------------

let dir: string
const SUBAGENT_ENV = [
  "MINIMAL_AGENT_SUBAGENT_ID",
  "MINIMAL_AGENT_SUBAGENT_LEAD",
  "MINIMAL_AGENT_SUBAGENT_ROLE",
  "MINIMAL_AGENT_SUBAGENT_SID",
] as const
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-session-catalog-"))
  savedEnv = {}
  for (const k of [...SUBAGENT_ENV, "MINIMAL_AGENT_HOME"]) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(dir, { recursive: true, force: true })
})

const base = {
  model: "test-model",
  cwd: "/tmp/proj",
  systemHash: "",
  toolsHash: "",
  agentVersion: "test",
}

/** A UUID-like sid from a number. */
function sidOf(n: number, prefix = "aaaaaaaa"): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
}

/**
 * A fixed time in the past (more than 24 h before the test run), so the
 * no-attach rules (1 h live, 24 h final) do not depend on the clock.
 */
function iso(minute: number): string {
  return new Date(Date.UTC(2026, 0, 19, 0, minute)).toISOString()
}

/** Write a session through the real store: `prompts` user turns, then a clean detach. */
function seedSession(
  sid: string,
  opts: {
    minute: number
    prompts?: string[]
    lineage?: { leadSid?: string; agentId?: string; role?: string } | null
    cwd?: string
    model?: string
    detach?: boolean
  },
): void {
  const store = SessionStore.open({
    ...base,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    sid,
    dir,
    lineage: opts.lineage ?? null,
    now: () => new Date(iso(opts.minute)),
  })
  for (const p of opts.prompts ?? []) store.appendUser(p, new Date(iso(opts.minute)))
  if (opts.detach) store.appendDetach("exit", 0, new Date(iso(opts.minute + 1)))
  setMtime(sid, iso(opts.detach ? opts.minute + 1 : opts.minute))
}

/** Set the file mtime to its last record time, as in real use (else a line looks stale, N2). */
function setMtime(sid: string, at: string): void {
  const t = new Date(at)
  utimesSync(sessionFilePath(sid, dir), t, t)
}

/** The JSON lines of one file; `[]` when it is missing. */
function jsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** The lines of `index.jsonl`, then the lines of the sidecar `index-meta.jsonl`. */
function indexLines(): Record<string, unknown>[] {
  return [...jsonLines(indexFilePath(dir)), ...jsonLines(indexMetaFilePath(dir))]
}

/** An io that counts session-file reads and checks. */
function countingIo(): SessionCatalogIo & { reads: string[]; checks: string[]; appends: number } {
  const io = {
    reads: [] as string[],
    checks: [] as string[],
    appends: 0,
    readFile(path: string): string {
      if (!path.endsWith("index.jsonl") && !path.endsWith("index-meta.jsonl")) io.reads.push(path)
      return defaultSessionCatalogIo.readFile(path)
    },
    exists(path: string): boolean {
      io.checks.push(path)
      return defaultSessionCatalogIo.exists(path)
    },
    size(path: string): number {
      return statSync(path).size
    },
    stat(path: string): { size: number; mtimeMs: number } {
      const st = statSync(path)
      return { size: st.size, mtimeMs: st.mtimeMs }
    },
    appendSummary(indexPath: string, line: IndexSummaryRecord): boolean {
      io.appends += 1
      return defaultSessionCatalogIo.appendSummary(indexPath, line)
    },
  }
  return io
}

// ---------------------------------------------------------------------------
// Items 1-2: lineage on the index line.
// ---------------------------------------------------------------------------

describe("index lineage (leadSid, agentId, role)", () => {
  test("open() reads the lineage from the sub-agent env for the pinned sub-agent sid", () => {
    process.env.MINIMAL_AGENT_SUBAGENT_LEAD = "lead-sid-1"
    process.env.MINIMAL_AGENT_SUBAGENT_ID = "A3"
    process.env.MINIMAL_AGENT_SUBAGENT_ROLE = "explorer"
    process.env.MINIMAL_AGENT_SUBAGENT_SID = "child-1"
    SessionStore.open({ ...base, sid: "child-1", dir })
    const [line] = indexLines() as unknown as IndexRecord[]
    expect(line.leadSid).toBe("lead-sid-1")
    expect(line.agentId).toBe("A3")
    expect(line.role).toBe("explorer")
  })

  test("lineage guard: an inherited sub-agent env with a different session records none", () => {
    process.env.MINIMAL_AGENT_SUBAGENT_LEAD = "lead-sid-1"
    process.env.MINIMAL_AGENT_SUBAGENT_ID = "A3"
    // No SUBAGENT_SID and no --session-id in argv: a `ma` run from a worker shell.
    SessionStore.open({ ...base, sid: "shell-run", dir })
    // SUBAGENT_SID names another session: a fork or a second session of the worker.
    process.env.MINIMAL_AGENT_SUBAGENT_SID = "the-worker"
    SessionStore.open({ ...base, sid: "other-run", dir })
    for (const line of indexLines()) {
      expect("leadSid" in line).toBe(false)
      expect("agentId" in line).toBe(false)
    }
  })

  test("isPinnedSubagentSid: env sid wins, else --session-id in argv", () => {
    const env = (sid?: string) => (sid ? { MINIMAL_AGENT_SUBAGENT_SID: sid } : {})
    expect(isPinnedSubagentSid("s1", env("s1"), [])).toBe(true)
    expect(isPinnedSubagentSid("s1", env("s2"), ["--session-id", "s1"])).toBe(false)
    expect(isPinnedSubagentSid("s1", env(), ["bun", "x.ts", "--session-id", "s1"])).toBe(true)
    expect(isPinnedSubagentSid("s1", env(), ["--session-id=s1"])).toBe(true)
    expect(isPinnedSubagentSid("s1", env(), ["--session-id", "s2"])).toBe(false)
    expect(isPinnedSubagentSid("s1", env(), ["--resume", "s1"])).toBe(false)
  })

  test("open() writes no lineage fields for a top-level session", () => {
    SessionStore.open({ ...base, sid: "top-1", dir })
    const [line] = indexLines()
    expect("leadSid" in line).toBe(false)
    expect("agentId" in line).toBe(false)
    expect("role" in line).toBe(false)
  })

  test("an explicit lineage wins, and null writes none", () => {
    process.env.MINIMAL_AGENT_SUBAGENT_LEAD = "from-env"
    SessionStore.open({ ...base, sid: "x1", dir, lineage: { leadSid: "L", role: "worker" } })
    SessionStore.open({ ...base, sid: "x2", dir, lineage: null })
    const [a, b] = indexLines() as unknown as IndexRecord[]
    expect(a.leadSid).toBe("L")
    expect(a.role).toBe("worker")
    expect(a.agentId).toBeUndefined()
    expect(b.leadSid).toBeUndefined()
  })

  test("fork() stamps the lineage too", () => {
    seedSession("src-1", { minute: 0, prompts: ["hi"] })
    SessionStore.fork({
      ...base,
      srcSid: "src-1",
      dstSid: "dst-1",
      dir,
      lineage: { leadSid: "L2", agentId: "A1", role: "worker" },
    })
    const fork = indexLines().find((l) => l.sid === "dst-1") as unknown as IndexRecord
    expect(fork.leadSid).toBe("L2")
    expect(fork.agentId).toBe("A1")
  })
})

// ---------------------------------------------------------------------------
// Item 3: summary line at close, and old readers.
// ---------------------------------------------------------------------------

describe("index summary line", () => {
  test("appendDetach appends a summary line", () => {
    seedSession("s-close", {
      minute: 0,
      prompts: ['<ma::agent::mode-change from="a" to="b" /> build it', "next"],
      detach: true,
    })
    const lines = indexLines()
    expect(lines).toHaveLength(2)
    const summary = lines[1] as unknown as IndexSummaryRecord
    expect(summary.kind).toBe("summary")
    expect(summary.sid).toBe("s-close")
    expect(summary.title).toBe("build it")
    expect(summary.turns).toBe(2)
    expect(summary.status).toBe("done")
    expect(summary.endedAt).toBe(iso(1))
  })

  test("an error detach writes status failed", () => {
    const store = SessionStore.open({ ...base, sid: "s-err", dir, lineage: null })
    store.appendUser("x")
    store.appendDetach("error")
    expect((indexLines()[1] as unknown as IndexSummaryRecord).status).toBe("failed")
  })

  test("readSessionIndex does not return summary lines as sessions", () => {
    process.env.MINIMAL_AGENT_HOME = join(dir, "home")
    const sessionsDir = join(dir, "home", "sessions")
    SessionStore.open({ ...base, sid: "s-old", dir: sessionsDir, lineage: null }).appendDetach(
      "exit",
      0,
    )
    const recs = readSessionIndex()
    expect(recs.map((r) => r.sid)).toEqual(["s-old"])
    expect(recs.every((r) => !("kind" in r))).toBe(true)
  })

  test("parseSessionIndexText merges by sid: the last summary wins", () => {
    const text = [
      JSON.stringify({ sid: "a", createdAt: iso(0), cwd: "/", model: "m" }),
      JSON.stringify({ kind: "summary", sid: "a", title: "one", turns: 1 }),
      "{not json",
      JSON.stringify({ kind: "summary", sid: "a", title: "two", turns: 2 }),
      JSON.stringify({ kind: "future-kind", sid: "a" }),
      "",
    ].join("\n")
    const parsed = parseSessionIndexText(text)
    expect(parsed.sessions.map((s) => s.sid)).toEqual(["a"])
    expect(parsed.summaries.get("a")?.title).toBe("two")
  })

  test("cleanupIfUnused also removes the summary lines of its sid (tombstone)", () => {
    const store = SessionStore.open({ ...base, sid: "s-empty", dir, lineage: null })
    store.appendIndexSummary()
    expect(indexLines()).toHaveLength(2)
    expect(store.cleanupIfUnused()).toBe(true)
    const parsed = readParsedSessionIndex(dir)
    expect(parsed.sessions).toEqual([])
    expect(parsed.summaries.size).toBe(0)
  })

  test("M1: cleanupIfUnused appends a tombstone and never rewrites the index", () => {
    seedSession("m1-keep", { minute: 0, prompts: ["x"], detach: true })
    const store = SessionStore.open({ ...base, sid: "m1-drop", dir, lineage: null })
    const before = readFileSync(indexFilePath(dir), "utf-8")
    // A line that another process appended after this process opened.
    const foreign = JSON.stringify({ sid: "m1-other", createdAt: iso(5), cwd: "/", model: "m" })
    writeFileSync(indexFilePath(dir), `${foreign}\n`, { flag: "a" })
    expect(store.cleanupIfUnused()).toBe(true)
    const after = readFileSync(indexFilePath(dir), "utf-8")
    // Append-only: the old bytes and the foreign line are kept as they were.
    expect(after.startsWith(`${before}${foreign}\n`)).toBe(true)
    expect(indexLines().at(-1)).toMatchObject({ kind: "tombstone", sid: "m1-drop" })
    const sids = readParsedSessionIndex(dir).sessions.map((s) => s.sid)
    expect(sids).toEqual(["m1-keep", "m1-other"])
    // A session line of the same sid after the tombstone is a new session.
    const again = JSON.stringify({ sid: "m1-drop", createdAt: iso(9), cwd: "/", model: "m" })
    writeFileSync(indexFilePath(dir), `${again}\n`, { flag: "a" })
    expect(readParsedSessionIndex(dir).sessions.map((s) => s.sid)).toEqual([
      "m1-keep",
      "m1-other",
      "m1-drop",
    ])
  })
})

// ---------------------------------------------------------------------------
// Items 5-7: listSessions.
// ---------------------------------------------------------------------------

describe("listSessions", () => {
  test("lists leads newest first, with children attached by leadSid", () => {
    seedSession("lead-old", { minute: 0, prompts: ["old task"], detach: true })
    seedSession("lead-new", { minute: 10, prompts: ["new task"], detach: true })
    seedSession("kid-2", {
      minute: 12,
      prompts: ["second kid"],
      detach: true,
      lineage: { leadSid: "lead-new", agentId: "A2", role: "explorer" },
    })
    seedSession("kid-1", {
      minute: 11,
      prompts: ["first kid"],
      detach: true,
      lineage: { leadSid: "lead-new", agentId: "A1", role: "worker" },
    })
    const io = countingIo()
    const out = listSessions({ dir, io, writeSummaries: false })
    expect(out.rows.map((r) => r.sid)).toEqual(["lead-new", "lead-old"])
    expect(out.rows[0].children.map((c) => c.agentId)).toEqual(["A1", "A2"])
    expect(out.rows[0].children[1].role).toBe("explorer")
    expect(out.rows[0].summary?.title).toBe("new task")
    expect(out.rows[0].summarySource).toBe("index")
    expect(out.total).toBe(2)
    expect(out.hiddenCount).toBe(0)
    // All rows had index summaries: no session file was read.
    expect(io.reads).toEqual([])
  })

  test("hides empty, backup, fixture sessions; includeHidden returns them with a reason", () => {
    seedSession("real-1", { minute: 0, prompts: ["work"], detach: true })
    seedSession("empty-1", { minute: 1, detach: true })
    seedSession(sidOf(1, "00000000"), { minute: 2, prompts: ["PONG"], detach: true })
    seedSession("backup-1", { minute: 3, prompts: ["old"], detach: true })
    writeFileSync(
      indexFilePath(dir),
      `${JSON.stringify({ sid: "backup-1x", createdAt: iso(4), cwd: "/", model: "m", backup: true })}\n`,
      { flag: "a" },
    )
    writeFileSync(sessionFilePath("backup-1x", dir), `${JSON.stringify({ kind: "meta" })}\n`)
    const out = listSessions({ dir, writeSummaries: false })
    expect(out.rows.map((r) => r.sid)).toEqual(["backup-1", "real-1"])
    expect(out.hiddenCount).toBe(3)
    expect(out.total).toBe(2)

    const all = listSessions({ dir, writeSummaries: false, includeHidden: true })
    const reasons = Object.fromEntries(all.rows.map((r) => [r.sid, r.hiddenReason ?? "-"]))
    expect(reasons).toEqual({
      "backup-1x": "backup",
      "backup-1": "-",
      [sidOf(1, "00000000")]: "fixture",
      "empty-1": "empty",
      "real-1": "-",
    })
    expect(all.total).toBe(5)
  })

  test("D3: an empty child (0 turns) is hidden and counted; includeHidden shows it", () => {
    seedSession("lead-e", { minute: 0, prompts: ["lead task"], detach: true })
    seedSession("kid-full", {
      minute: 1,
      prompts: ["kid task"],
      detach: true,
      lineage: { leadSid: "lead-e", agentId: "A1" },
    })
    seedSession("kid-empty", { minute: 2, detach: true, lineage: { leadSid: "lead-e" } })
    const out = listSessions({ dir, writeSummaries: false })
    expect(out.rows[0].children.map((c) => c.sid)).toEqual(["kid-full"])
    expect(out.hiddenCount).toBe(1)
    expect(out.total).toBe(1)
    const all = listSessions({ dir, writeSummaries: false, includeHidden: true })
    expect(all.rows[0].children.map((c) => [c.sid, c.hiddenReason ?? "-"])).toEqual([
      ["kid-full", "-"],
      ["kid-empty", "empty"],
    ])
    expect(all.total).toBe(1)
  })

  test("a child whose lead is not in the index is hidden as orphan-child", () => {
    seedSession("kid-x", {
      minute: 0,
      prompts: ["k"],
      detach: true,
      lineage: { leadSid: "missing-lead" },
    })
    const out = listSessions({ dir, writeSummaries: false })
    expect(out.rows).toEqual([])
    expect(out.hiddenCount).toBe(1)
    const all = listSessions({ dir, writeSummaries: false, includeHidden: true })
    expect(all.rows[0].hiddenReason).toBe("orphan-child")
  })

  test("M6: a grandchild (lead → child → grandchild) is under its parent child", () => {
    seedSession("g-lead", { minute: 0, prompts: ["lead"], detach: true })
    seedSession("g-kid", {
      minute: 1,
      prompts: ["kid"],
      detach: true,
      lineage: { leadSid: "g-lead", agentId: "A1" },
    })
    seedSession("g-grand", {
      minute: 2,
      prompts: ["grand"],
      detach: true,
      lineage: { leadSid: "g-kid", agentId: "A1" },
    })
    seedSession("g-grand-empty", { minute: 3, detach: true, lineage: { leadSid: "g-kid" } })
    const out = listSessions({ dir, writeSummaries: false })
    expect(out.rows.map((r) => r.sid)).toEqual(["g-lead"])
    expect(out.rows[0].children.map((c) => c.sid)).toEqual(["g-kid"])
    expect(out.rows[0].children[0].children.map((c) => c.sid)).toEqual(["g-grand"])
    expect(out.total).toBe(1)
    expect(out.hiddenCount).toBe(1)
    const all = listSessions({ dir, writeSummaries: false, includeHidden: true })
    expect(all.rows[0].children[0].children.map((c) => c.sid)).toEqual(["g-grand", "g-grand-empty"])
  })

  test("M6: a lead cycle and a child of an orphan are listed, not lost", () => {
    seedSession("cy-a", { minute: 0, prompts: ["a"], detach: true, lineage: { leadSid: "cy-b" } })
    seedSession("cy-b", { minute: 1, prompts: ["b"], detach: true, lineage: { leadSid: "cy-a" } })
    seedSession("or-kid", { minute: 2, prompts: ["k"], detach: true, lineage: { leadSid: "nope" } })
    seedSession("or-grand", {
      minute: 3,
      prompts: ["g"],
      detach: true,
      lineage: { leadSid: "or-kid" },
    })
    const out = listSessions({ dir, writeSummaries: false })
    expect(out.rows).toEqual([])
    expect(out.hiddenCount).toBe(3)
    const all = listSessions({ dir, writeSummaries: false, includeHidden: true })
    expect(all.rows.map((r) => [r.sid, r.hiddenReason])).toEqual([
      ["or-kid", "orphan-child"],
      ["cy-b", "orphan-child"],
      ["cy-a", "orphan-child"],
    ])
    expect(all.rows[0].children.map((c) => c.sid)).toEqual(["or-grand"])
    expect(all.rows[1].children).toEqual([])
  })

  test("filters: query on title/cwd/model/sid, cwd, model, since", () => {
    seedSession("s-alpha", { minute: 0, prompts: ["Refactor PARSER"], detach: true, cwd: "/a" })
    seedSession("s-beta", {
      minute: 5,
      prompts: ["other"],
      detach: true,
      model: "zeta-x",
      cwd: "/b",
    })
    const q = (query: string) =>
      listSessions({ dir, writeSummaries: false, query }).rows.map((r) => r.sid)
    expect(q("parser")).toEqual(["s-alpha"])
    expect(q("ZETA")).toEqual(["s-beta"])
    expect(q("/b")).toEqual(["s-beta"])
    expect(q("S-ALPHA")).toEqual(["s-alpha"])
    expect(q("nothing")).toEqual([])
    expect(listSessions({ dir, writeSummaries: false, cwd: "/a" }).rows.map((r) => r.sid)).toEqual([
      "s-alpha",
    ])
    expect(
      listSessions({ dir, writeSummaries: false, model: "zeta" }).rows.map((r) => r.sid),
    ).toEqual(["s-beta"])
    expect(
      listSessions({ dir, writeSummaries: false, since: iso(3) }).rows.map((r) => r.sid),
    ).toEqual(["s-beta"])
  })

  test("pages: limit and page", () => {
    for (let i = 0; i < 5; i++) seedSession(`p-${i}`, { minute: i, prompts: ["x"], detach: true })
    const p0 = listSessions({ dir, writeSummaries: false, limit: 2 })
    const p2 = listSessions({ dir, writeSummaries: false, limit: 2, page: 2 })
    expect(p0.rows.map((r) => r.sid)).toEqual(["p-4", "p-3"])
    expect(p2.rows.map((r) => r.sid)).toEqual(["p-0"])
    expect(p0.total).toBe(5)
  })

  test("M2: a bad index line (unsafe sid, missing model or cwd) is skipped, no throw", () => {
    seedSession("good-1", { minute: 0, prompts: ["ok"], detach: true })
    const bad = [
      { sid: "../evil", createdAt: iso(5), cwd: "/", model: "m" },
      { sid: "no-model", createdAt: iso(6), cwd: "/" },
      { sid: "no-cwd", createdAt: iso(7), model: "m" },
      { sid: "num-date", createdAt: 7, cwd: "/", model: "m" },
      { kind: "summary", sid: "good-1", v: 2, title: 5 },
    ]
    writeFileSync(indexFilePath(dir), `${bad.map((l) => JSON.stringify(l)).join("\n")}\n`, {
      flag: "a",
    })
    const run = () => listSessions({ dir, writeSummaries: false, query: "o", model: "m" })
    expect(run).not.toThrow()
    expect(listSessions({ dir, writeSummaries: false }).rows.map((r) => r.sid)).toEqual(["good-1"])
    expect(parseSessionIndexText(readFileSync(indexFilePath(dir), "utf-8")).sessions).toHaveLength(
      1,
    )
  })

  test("drops a row whose session file is gone", () => {
    seedSession("gone", { minute: 0, prompts: ["x"], detach: true })
    seedSession("here", { minute: 1, prompts: ["y"], detach: true })
    rmSync(sessionFilePath("gone", dir))
    const out = listSessions({ dir, writeSummaries: false })
    expect(out.rows.map((r) => r.sid)).toEqual(["here"])
    expect(out.total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Item 6: lazy summary.
// ---------------------------------------------------------------------------

describe("listSessions lazy summary", () => {
  /** A session with no summary line: an old session from before this change. */
  function seedOld(sid: string, minute: number, prompt: string): void {
    const store = SessionStore.open({
      ...base,
      sid,
      dir,
      lineage: null,
      now: () => new Date(iso(minute)),
    })
    store.appendUser(`<ma::agent::policy>t</ma::agent::policy>${prompt}`, new Date(iso(minute)))
    setMtime(sid, iso(minute))
  }

  test("computes the summary of a returned row and appends it once", () => {
    seedOld("old-1", 0, "legacy prompt")
    seedOld("old-2", 1, "second legacy")
    const io = countingIo()
    const out = listSessions({ dir, io, limit: 1 })
    expect(out.rows[0].sid).toBe("old-2")
    expect(out.rows[0].summarySource).toBe("computed")
    expect(out.rows[0].summary?.title).toBe("second legacy")
    expect(out.rows[0].summary?.turns).toBe(1)
    // Only the row on the page was read.
    expect(io.reads).toEqual([sessionFilePath("old-2", dir)])
    expect(io.appends).toBe(1)
    const summaries = indexLines().filter((l) => l.kind === "summary")
    expect(summaries.map((l) => l.sid)).toEqual(["old-2"])

    const io2 = countingIo()
    const again = listSessions({ dir, io: io2, limit: 1 })
    expect(again.rows[0].summarySource).toBe("index")
    expect(io2.reads).toEqual([])
    expect(io2.appends).toBe(0)
  })

  test("writeSummaries:false computes but writes nothing", () => {
    seedOld("old-3", 0, "dry run")
    const before = readFileSync(indexFilePath(dir), "utf-8")
    const out = listSessions({ dir, writeSummaries: false })
    expect(out.rows[0].summary?.title).toBe("dry run")
    expect(readFileSync(indexFilePath(dir), "utf-8")).toBe(before)
  })

  test("a live session (open attach) is summarized but not written", () => {
    const store = SessionStore.open({ ...base, sid: "live-1", dir, lineage: null })
    store.appendAttach()
    store.appendUser("still running")
    const out = listSessions({ dir, liveness: { probe: () => "alive", readStart: () => null } })
    expect(out.rows[0].live).toBe(true)
    expect(indexLines().some((l) => l.kind === "summary")).toBe(false)
  })

  test("D1: a pid-gone session with no detach is done, and the new line has v 3", () => {
    const store = SessionStore.open({ ...base, sid: "killed-1", dir, lineage: null })
    store.appendAttach()
    store.appendUser("worker task")
    const gone = { probe: () => "dead" as const, readStart: () => null }
    const out = listSessions({ dir, liveness: gone })
    expect(out.rows[0].live).toBe(false)
    expect(out.rows[0].summary?.status).toBe("done")
    const line = indexLines().find((l) => l.kind === "summary")
    expect(line?.status).toBe("done")
    expect(line?.v).toBe(3)
  })

  test("D1: an old (no v) failed line with no detach is computed again as done", () => {
    const store = SessionStore.open({ ...base, sid: "killed-2", dir, lineage: null })
    store.appendAttach()
    store.appendUser("old worker")
    const old = { kind: "summary", sid: "killed-2", title: "t", tokens: 1, estimated: false }
    writeFileSync(
      indexFilePath(dir),
      `${JSON.stringify({ ...old, turns: 1, endedAt: iso(0), status: "failed" })}\n`,
      { flag: "a" },
    )
    const gone = { probe: () => "dead" as const, readStart: () => null }
    const out = listSessions({ dir, writeSummaries: false, liveness: gone })
    expect(out.rows[0].summarySource).toBe("computed")
    expect(out.rows[0].summary?.status).toBe("done")
  })

  test("D1: an old failed line with an error detach stays failed; a v3 failed line is trusted", () => {
    const a = SessionStore.open({ ...base, sid: "err-old", dir, lineage: null })
    a.appendAttach()
    a.appendUser("x")
    a.appendDetach("error")
    const b = SessionStore.open({ ...base, sid: "err-v2", dir, lineage: null })
    b.appendAttach()
    b.appendUser("y")
    const fixed = { title: "t", tokens: 1, estimated: false, turns: 1, endedAt: iso(0) }
    writeFileSync(
      indexFilePath(dir),
      `${JSON.stringify({ kind: "summary", sid: "err-v2", v: 3, ...fixed, status: "failed" })}\n`,
      { flag: "a" },
    )
    setMtime("err-v2", iso(0))
    const io = countingIo()
    const gone = { probe: () => "dead" as const, readStart: () => null }
    const out = listSessions({ dir, io, writeSummaries: false, liveness: gone })
    const bySid = Object.fromEntries(out.rows.map((r) => [r.sid, r]))
    expect(bySid["err-old"].summary?.status).toBe("failed")
    expect(bySid["err-v2"].summary?.status).toBe("failed")
    expect(bySid["err-v2"].summarySource).toBe("index")
  })

  test("N1: exit 129/130/143 is done; a v2 failed line with such a code is computed again", () => {
    const codes = { "hup-1": 129, "int-1": 130, "term-1": 143, "one-1": 1 }
    for (const [sid, code] of Object.entries(codes)) {
      const store = SessionStore.open({ ...base, sid, dir, lineage: null })
      store.appendAttach()
      store.appendUser(`task ${sid}`)
      store.appendDetach("exit", code)
    }
    const status = () =>
      Object.fromEntries(
        listSessions({ dir, writeSummaries: false }).rows.map((r) => [r.sid, r.summary?.status]),
      )
    // The close path writes v3 lines with the new rule.
    expect(status()).toEqual({
      "hup-1": "done",
      "int-1": "done",
      "term-1": "done",
      "one-1": "failed",
    })
    expect(jsonLines(indexMetaFilePath(dir)).every((l) => l.v === 3)).toBe(true)
    // Old v2 `failed` lines (written by the previous rule) are checked again.
    const v2 = (sid: string) =>
      JSON.stringify({
        kind: "summary",
        sid,
        v: 2,
        title: "t",
        tokens: 0,
        estimated: false,
        turns: 1,
        endedAt: iso(0),
        status: "failed",
      })
    const sids = ["hup-1", "int-1", "term-1", "one-1"]
    writeFileSync(indexMetaFilePath(dir), `${sids.map(v2).join("\n")}\n`, { flag: "a" })
    expect(status()).toEqual({
      "hup-1": "done",
      "int-1": "done",
      "term-1": "done",
      "one-1": "failed",
    })
    // With writes on, the recomputed rows get a v3 line, and the next call trusts it.
    listSessions({ dir })
    const io = countingIo()
    const again = listSessions({ dir, io, writeSummaries: false })
    expect(again.rows.every((r) => r.summarySource === "index")).toBe(true)
    expect(io.reads).toEqual([])
  })

  test("M4: a recent session with no attach (runtime/web) is live and not written", () => {
    const store = SessionStore.open({ ...base, sid: "web-1", dir, lineage: null })
    const io = countingIo()
    const empty = listSessions({ dir, io, includeHidden: true })
    expect(empty.rows[0].live).toBe(true)
    store.appendUser("now it has a turn")
    const out = listSessions({ dir, io })
    expect(out.rows.map((r) => r.sid)).toEqual(["web-1"])
    expect(out.rows[0].live).toBe(true)
    expect(io.appends).toBe(0)
    expect(indexLines().some((l) => l.kind === "summary")).toBe(false)
  })

  test("N3: a no-attach (runtime/web) session gets a line only after 24 h and with a turn", () => {
    const hour = 60 * 60 * 1000
    const at = (msAgo: number) => new Date(Date.now() - msAgo)
    const web = (sid: string, msAgo: number, prompt?: string) => {
      const store = SessionStore.open({ ...base, sid, dir, lineage: null, now: () => at(msAgo) })
      if (prompt) store.appendUser(prompt, at(msAgo))
      utimesSync(sessionFilePath(sid, dir), at(msAgo), at(msAgo))
    }
    web("n3-idle-2h", 2 * hour, "idle web session")
    web("n3-empty-2d", 48 * hour)
    web("n3-old-2d", 48 * hour, "old web session")
    const io = countingIo()
    const out = listSessions({ dir, io, includeHidden: true })
    const bySid = Object.fromEntries(out.rows.map((r) => [r.sid, r]))
    // All three are computed and shown; none is live (no attach, > 1 h).
    expect(bySid["n3-idle-2h"].summary?.turns).toBe(1)
    expect(bySid["n3-empty-2d"].hiddenReason).toBe("empty")
    expect(bySid["n3-idle-2h"].live).toBe(false)
    // Only the old session with a turn gets a final line.
    expect(io.appends).toBe(1)
    expect(jsonLines(indexMetaFilePath(dir)).map((l) => l.sid)).toEqual(["n3-old-2d"])
    // The idle one gets a turn later: it is not hidden or stale.
    SessionStore.open({
      ...base,
      sid: "n3-empty-2d",
      dir,
      lineage: null,
      existsOk: true,
    }).appendUser("now it has a turn")
    const later = listSessions({ dir, writeSummaries: false })
    expect(later.rows.find((r) => r.sid === "n3-empty-2d")?.summary?.turns).toBe(1)
  })

  test("N2: a resumed session newer than its summary line is computed again and live", () => {
    seedSession("n2-res", { minute: 0, prompts: ["first run"], detach: true })
    seedSession("n2-other", { minute: 1, prompts: ["closed"], detach: true })
    expect(jsonLines(indexMetaFilePath(dir)).map((l) => l.sid)).toEqual(["n2-res", "n2-other"])
    // A same-sid resume now: attach and a new turn, no detach yet.
    const store = SessionStore.open({ ...base, sid: "n2-res", dir, lineage: null, existsOk: true })
    store.appendAttach()
    store.appendUser("second run")
    const alive = { probe: () => "alive" as const, readStart: () => null }
    const io = countingIo()
    const out = listSessions({ dir, io, liveness: alive })
    const row = out.rows.find((r) => r.sid === "n2-res")
    expect(row?.summarySource).toBe("computed")
    expect(row?.live).toBe(true)
    expect(row?.summary?.turns).toBe(2)
    // The other row keeps its index line; nothing is written for a live row.
    expect(out.rows.find((r) => r.sid === "n2-other")?.summarySource).toBe("index")
    expect(io.reads).toEqual([sessionFilePath("n2-res", dir)])
    expect(io.appends).toBe(0)
    // The stale line does not count as known: the row is unknown.
    expect(out.unknownCount).toBe(1)
    // After the resumed run ends, its new line wins and is trusted.
    store.appendDetach("exit", 0)
    const io2 = countingIo()
    const done = listSessions({ dir, io: io2 })
    expect(done.rows.find((r) => r.sid === "n2-res")?.summary?.turns).toBe(2)
    expect(io2.reads).toEqual([])
    expect(done.unknownCount).toBe(0)
  })

  test("N2: a file with a touched mtime is computed but never written again", () => {
    seedOld("n2-touch", 0, "touched")
    utimesSync(sessionFilePath("n2-touch", dir), new Date(), new Date())
    const gone = { probe: () => "dead" as const, readStart: () => null }
    const io = countingIo()
    listSessions({ dir, io, liveness: gone })
    listSessions({ dir, io, liveness: gone })
    expect(io.appends).toBe(0)
    expect(jsonLines(indexMetaFilePath(dir))).toEqual([])
  })

  test("D2: an old empty session found on the page is hidden; counts stay index-only", () => {
    SessionStore.open({ ...base, sid: "old-empty", dir, lineage: null })
    seedOld("old-full", 0, "has text")
    const out = listSessions({ dir, writeSummaries: false })
    expect(out.rows.map((r) => r.sid)).toEqual(["old-full"])
    // Neither row has a summary line: both are "unknown", so `total` is an
    // upper bound and `hiddenCount` a lower bound.
    expect(out.unknownCount).toBe(2)
    expect(out.total).toBe(2)
    expect(out.hiddenCount).toBe(0)
  })

  test("M3: 3 pages with empty and stale rows: no repeat, no gap, same total", () => {
    // 25 sessions with no summary line; every 7th is empty; one file is gone.
    for (let i = 0; i < 25; i++) {
      const sid = `m3-${String(i).padStart(2, "0")}`
      if (i % 7 === 0)
        SessionStore.open({ ...base, sid, dir, lineage: null, now: () => new Date(iso(i)) })
      else seedOld(sid, i, `task ${i}`)
    }
    rmSync(sessionFilePath("m3-10", dir))
    const pages = [0, 1, 2].map((page) =>
      listSessions({ dir, writeSummaries: false, limit: 7, page }),
    )
    const seen = pages.flatMap((p) => p.rows.map((r) => r.sid))
    const want = Array.from({ length: 25 }, (_, i) => i)
      .filter((i) => i % 7 !== 0 && i !== 10)
      .reverse()
      .map((i) => `m3-${String(i).padStart(2, "0")}`)
    expect(seen).toEqual(want)
    expect(new Set(pages.map((p) => p.total))).toEqual(new Set([24]))
    expect(new Set(pages.map((p) => p.hiddenCount))).toEqual(new Set([0]))
    expect(new Set(pages.map((p) => p.unknownCount))).toEqual(new Set([24]))
  })

  test("D2: total, hiddenCount and unknownCount; a stale line is not counted", () => {
    seedSession("d2-full", { minute: 0, prompts: ["x"], detach: true })
    seedSession("d2-empty", { minute: 1, detach: true })
    seedOld("d2-old", 2, "no summary line")
    seedOld("d2-gone", 3, "file gone")
    rmSync(sessionFilePath("d2-gone", dir))
    seedSession("d2-gone2", { minute: 4, prompts: ["y"], detach: true })
    rmSync(sessionFilePath("d2-gone2", dir))
    const out = listSessions({ dir, writeSummaries: false })
    expect(out.rows.map((r) => r.sid)).toEqual(["d2-old", "d2-full"])
    expect(out.total).toBe(2)
    expect(out.hiddenCount).toBe(1)
    expect(out.unknownCount).toBe(1)
    const all = listSessions({ dir, writeSummaries: false, includeHidden: true })
    expect(all.total).toBe(3)
    expect(all.unknownCount).toBe(1)
  })

  test("m4: the default size limit is the close-path limit (8 MiB)", () => {
    seedOld("m4-big", 0, "big")
    const io = countingIo()
    io.size = () => 8 * 1024 * 1024 + 1
    const out = listSessions({ dir, io, writeSummaries: false })
    expect(out.rows[0].summarySource).toBe("none")
    expect(io.reads).toEqual([])
  })

  test("m8: a bad since value throws, also with no index", () => {
    // The message proves that `sinceIso` threw, not `new Date(NaN).toISOString()`.
    const bad = /listSessions: bad since value/
    expect(() => listSessions({ dir, writeSummaries: false, since: "2x" })).toThrow(bad)
    expect(() => listSessions({ dir, writeSummaries: false, since: Number.NaN })).toThrow(bad)
    expect(() => listSessions({ dir, writeSummaries: false, since: new Date("x") })).toThrow(bad)
    seedSession("m8-a", { minute: 0, prompts: ["x"], detach: true })
    expect(() => listSessions({ dir, writeSummaries: false, since: "2x" })).toThrow(bad)
    expect(listSessions({ dir, writeSummaries: false, since: iso(0) }).rows).toHaveLength(1)
  })

  test("a file larger than maxSummaryBytes is not read", () => {
    seedOld("big-1", 0, "big")
    const io = countingIo()
    const out = listSessions({ dir, io, writeSummaries: false, maxSummaryBytes: 10 })
    expect(out.rows[0].summarySource).toBe("none")
    expect(io.reads).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Item 8: performance.
// ---------------------------------------------------------------------------

describe("listSessions performance", () => {
  test("20k index records with summaries: under 200 ms (5x on CI) and zero session-file reads", () => {
    const N = 20_000
    const lines: string[] = []
    for (let i = 0; i < N; i++) {
      const sid = sidOf(i)
      const isChild = i % 4 === 3
      lines.push(
        JSON.stringify({
          sid,
          createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
          cwd: `/Users/x/Projects/p${i % 37}`,
          model: i % 2 ? "model-big-1" : "model-small-2",
          argv: [
            "/bin/bun",
            "/x/src/index.ts",
            "--model",
            "model-big-1",
            "--prompt",
            "y".repeat(400),
          ],
          ...(isChild ? { leadSid: sidOf(i - 1), agentId: "A1", role: "worker" } : {}),
        }),
      )
      lines.push(
        JSON.stringify({
          kind: "summary",
          sid,
          title: `task number ${i}`,
          tokens: i * 10,
          estimated: false,
          turns: i % 10 === 0 ? 0 : 3,
          endedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000 + 30_000).toISOString(),
          status: "done",
        }),
      )
    }
    writeFileSync(indexFilePath(dir), `${lines.join("\n")}\n`)
    // Session files exist only for the newest rows the page needs.
    for (let i = N - 80; i < N; i++) {
      writeFileSync(sessionFilePath(sidOf(i), dir), "{}\n")
      // mtime = endedAt of its summary line: the line is not stale (N2).
      const t = new Date(Date.UTC(2026, 0, 1) + i * 60_000 + 30_000)
      utimesSync(sessionFilePath(sidOf(i), dir), t, t)
    }

    const io = countingIo()
    listSessions({ dir, io, writeSummaries: false }) // warm up the JIT
    io.reads.length = 0
    io.checks.length = 0
    const t0 = performance.now()
    const out = listSessions({ dir, io, writeSummaries: false })
    const ms = performance.now() - t0

    expect(out.rows).toHaveLength(30)
    expect(out.rows[0].children.length).toBeGreaterThan(0)
    expect(io.reads).toEqual([])
    // existsSync only for the returned rows and their children.
    const returned = out.rows.reduce((n, r) => n + 1 + r.children.length, 0)
    expect(io.checks.length).toBeLessThanOrEqual(returned + 10)
    expect(out.hiddenCount).toBeGreaterThan(0)
    expect(ms).toBeLessThan(perfBudgetMs(200))
    expect(existsSync(indexFilePath(dir))).toBe(true)
  })
})

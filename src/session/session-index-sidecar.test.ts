/**
 * P1 review N4: the summary and tombstone lines go to the sidecar
 * `index-meta.jsonl`, and `index.jsonl` keeps only session lines, so the
 * reader of older builds does not see them. Split from
 * `session-catalog.test.ts` (file size limit).
 */
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

import { listSessions } from "./session-catalog.ts"
import { parseSessionIndexText, readParsedSessionIndex } from "./session-index.ts"
import { indexFilePath, indexMetaFilePath, SessionStore, sessionFilePath } from "./session-store.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-session-sidecar-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const base = {
  model: "test-model",
  cwd: "/tmp/proj",
  systemHash: "",
  toolsHash: "",
  agentVersion: "test",
}

/** A fixed time in the past (see `session-catalog.test.ts`). */
function iso(minute: number): string {
  return new Date(Date.UTC(2026, 0, 19, 0, minute)).toISOString()
}

/** Set the mtime of a session file to the time of its last record. */
function setMtime(sid: string, at: string): void {
  const t = new Date(at)
  utimesSync(sessionFilePath(sid, dir), t, t)
}

/** Write a session through the real store: `prompts` user turns, then a clean detach. */
function seedSession(
  sid: string,
  opts: { minute: number; prompts?: string[]; detach?: boolean },
): void {
  const store = SessionStore.open({
    ...base,
    sid,
    dir,
    lineage: null,
    now: () => new Date(iso(opts.minute)),
  })
  for (const p of opts.prompts ?? []) store.appendUser(p, new Date(iso(opts.minute)))
  if (opts.detach) store.appendDetach("exit", 0, new Date(iso(opts.minute + 1)))
  setMtime(sid, iso(opts.detach ? opts.minute + 1 : opts.minute))
}

/** The JSON lines of one file; `[]` when it is missing. */
function jsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// N4: summary and tombstone lines go to the sidecar `index-meta.jsonl`.
// ---------------------------------------------------------------------------

/**
 * The reader of older builds (copy of `git show HEAD:src/session/session-index.ts`
 * `readSessionIndex`): each JSON line of `index.jsonl` whose session file
 * exists is a session. It has no `kind` filter.
 */
function oldBuildReadIndex(sessionsDir: string): Record<string, unknown>[] {
  let text: string
  try {
    text = readFileSync(indexFilePath(sessionsDir), "utf-8")
  } catch {
    return []
  }
  const out: Record<string, unknown>[] = []
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    try {
      const rec = JSON.parse(line) as { sid: string }
      if (!existsSync(sessionFilePath(rec.sid, sessionsDir))) continue
      out.push(rec)
    } catch {
      // Skip malformed lines silently — index is best-effort metadata.
    }
  }
  return out
}

describe("N4: index-meta.jsonl sidecar", () => {
  test("a new summary goes to the sidecar; index.jsonl has only session lines", () => {
    seedSession("n4-close", { minute: 0, prompts: ["closed"], detach: true })
    const old = SessionStore.open({ ...base, sid: "n4-old", dir, lineage: null })
    old.appendAttach()
    old.appendUser("lazy")
    listSessions({ dir, liveness: { probe: () => "dead", readStart: () => null } })
    const main = jsonLines(indexFilePath(dir))
    expect(main.map((l) => l.sid)).toEqual(["n4-close", "n4-old"])
    expect(main.every((l) => !("kind" in l))).toBe(true)
    const meta = jsonLines(indexMetaFilePath(dir))
    expect(meta.map((l) => [l.kind, l.sid])).toEqual([
      ["summary", "n4-close"],
      ["summary", "n4-old"],
    ])
  })

  test("an old-build reader sees no summary rows and resolves a short sid", () => {
    seedSession("aaaa1111-n4", { minute: 0, prompts: ["one"], detach: true })
    seedSession("bbbb2222-n4", { minute: 1, prompts: ["two"], detach: true })
    SessionStore.open({ ...base, sid: "cccc3333-n4", dir, lineage: null }).cleanupIfUnused()
    const rows = oldBuildReadIndex(dir)
    expect(rows.map((r) => r.sid)).toEqual(["aaaa1111-n4", "bbbb2222-n4"])
    for (const r of rows) {
      expect(typeof r.createdAt).toBe("string")
      expect("kind" in r).toBe(false)
    }
    // One entry per sid: an old `--resume aaaa` is not ambiguous.
    expect(rows.filter((r) => String(r.sid).startsWith("aaaa"))).toHaveLength(1)
  })

  test("old-format summary and tombstone lines in index.jsonl still merge", () => {
    seedSession("n4-a", { minute: 0, prompts: ["new a"], detach: true })
    seedSession("n4-b", { minute: 1, prompts: ["b"], detach: true })
    const old = { tokens: 1, estimated: false, turns: 4, endedAt: iso(2), status: "done" }
    const lines = [
      // An index.jsonl summary for a sid with no sidecar summary: used.
      { kind: "summary", sid: "n4-c", v: 2, title: "old c", ...old },
      { sid: "n4-c", createdAt: iso(2), cwd: "/", model: "m" },
      // An index.jsonl summary for n4-a: the sidecar line wins.
      { kind: "summary", sid: "n4-a", v: 2, title: "stale a", ...old },
      // An index.jsonl tombstone removes the earlier n4-b lines.
      { kind: "tombstone", sid: "n4-b", at: iso(3) },
    ]
    writeFileSync(indexFilePath(dir), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, {
      flag: "a",
    })
    writeFileSync(sessionFilePath("n4-c", dir), `${JSON.stringify({ kind: "meta" })}\n`)
    setMtime("n4-c", iso(2))
    const parsed = readParsedSessionIndex(dir)
    expect(parsed.sessions.map((s) => s.sid)).toEqual(["n4-a", "n4-c"])
    expect(parsed.summaries.get("n4-a")?.title).toBe("new a")
    expect(parsed.summaries.get("n4-c")?.title).toBe("old c")
    expect(parsed.summaries.has("n4-b")).toBe(false)
    const out = listSessions({ dir, writeSummaries: false })
    expect(out.rows.map((r) => [r.sid, r.summary?.title])).toEqual([
      ["n4-c", "old c"],
      ["n4-a", "new a"],
    ])
  })

  test("a sidecar tombstone cuts at indexBytes: a later re-use of the sid is kept", () => {
    const store = SessionStore.open({ ...base, sid: "n4-re", dir, lineage: null })
    store.appendIndexSummary()
    expect(store.cleanupIfUnused()).toBe(true)
    const tomb = jsonLines(indexMetaFilePath(dir)).at(-1)
    expect(tomb).toMatchObject({ kind: "tombstone", sid: "n4-re" })
    expect(tomb?.indexBytes).toBe(statSync(indexFilePath(dir)).size)
    expect(readParsedSessionIndex(dir).sessions).toEqual([])
    expect(readParsedSessionIndex(dir).summaries.size).toBe(0)
    seedSession("n4-re", { minute: 9, prompts: ["again"], detach: true })
    const parsed = readParsedSessionIndex(dir)
    expect(parsed.sessions.map((s) => s.createdAt)).toEqual([iso(9)])
    expect(parsed.summaries.get("n4-re")?.title).toBe("again")
  })

  test("parseSessionIndexText with no sidecar text is the old one-file parse", () => {
    const text = `${JSON.stringify({ sid: "p1", createdAt: iso(0), cwd: "/", model: "m" })}\n`
    expect(parseSessionIndexText(text).sessions.map((s) => s.sid)).toEqual(["p1"])
    const tomb = JSON.stringify({ kind: "tombstone", sid: "p1", at: iso(1) })
    expect(parseSessionIndexText(text, `${tomb}\n`).sessions).toEqual([])
  })
})

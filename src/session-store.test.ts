import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AssistantRecord,
  type IndexRecord,
  indexFilePath,
  type MetaRecord,
  parseLines,
  type RewindRecord,
  SessionStore,
  sessionFilePath,
  shortHash,
  type ToolResultRecord,
  type UserRecord,
} from "./session-store.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ma-session-store-"))
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

const baseOpenOpts = {
  model: "claude-sonnet-4-6",
  cwd: "/tmp/example",
  systemHash: "deadbeef",
  toolsHash: "cafebabe",
  agentVersion: "test",
}

describe("SessionStore.open", () => {
  it("writes a meta record and an index entry", () => {
    const dir = tmp()
    const sid = "ma-test-A"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })

    const fileLines = readJsonl(store.path)
    expect(fileLines).toHaveLength(1)
    const meta = fileLines[0] as MetaRecord
    expect(meta.kind).toBe("meta")
    expect(meta.formatVersion).toBe(1)
    expect(meta.sid).toBe(sid)
    expect(meta.model).toBe(baseOpenOpts.model)
    expect(meta.systemHash).toBe(baseOpenOpts.systemHash)
    expect(meta.toolsHash).toBe(baseOpenOpts.toolsHash)

    const indexLines = readJsonl(indexFilePath(dir))
    expect(indexLines).toHaveLength(1)
    const idx = indexLines[0] as IndexRecord
    expect(idx.sid).toBe(sid)
    expect(idx.cwd).toBe(baseOpenOpts.cwd)
  })

  it("throws when file exists and existsOk is false", () => {
    const dir = tmp()
    SessionStore.open({ ...baseOpenOpts, sid: "ma-dup", dir })
    expect(() => SessionStore.open({ ...baseOpenOpts, sid: "ma-dup", dir })).toThrow(
      /already exists/,
    )
  })

  it("appends to an existing file when existsOk is true", () => {
    const dir = tmp()
    const a = SessionStore.open({ ...baseOpenOpts, sid: "ma-keep", dir })
    a.appendNote("first run")
    const b = SessionStore.open({ ...baseOpenOpts, sid: "ma-keep", dir, existsOk: true })
    b.appendNote("second run")
    const lines = readJsonl(b.path)
    // meta + 2 notes
    expect(lines).toHaveLength(3)
    expect((lines[1] as { kind: string }).kind).toBe("note")
    expect((lines[2] as { kind: string }).kind).toBe("note")
  })
})

describe("SessionStore.append*", () => {
  it("round-trips user / assistant / tool_result / note", () => {
    const dir = tmp()
    const store = SessionStore.open({ ...baseOpenOpts, sid: "ma-rt", dir })

    store.appendUser("hello")
    store.appendAssistant(
      [
        { type: "text", text: "hi there" },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
      ],
      "tool_use",
      { input_tokens: 10, output_tokens: 20 },
    )
    store.appendToolResult({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "a.txt\nb.txt",
      is_error: false,
    })
    store.appendNote("turn complete")

    const lines = readJsonl(store.path)
    // meta + 4 events
    expect(lines).toHaveLength(5)

    const u = lines[1] as UserRecord
    expect(u.kind).toBe("user")
    expect(u.content).toBe("hello")

    const a = lines[2] as AssistantRecord
    expect(a.kind).toBe("assistant")
    expect(a.content).toHaveLength(2)
    expect(a.stopReason).toBe("tool_use")
    expect(a.usage?.input_tokens).toBe(10)

    const t = lines[3] as ToolResultRecord
    expect(t.kind).toBe("tool_result")
    expect(t.tool_use_id).toBe("tu_1")
    expect(t.isError).toBe(false)
    expect(t.content).toBe("a.txt\nb.txt")

    expect((lines[4] as { kind: string }).kind).toBe("note")
  })

  it("preserves a large tool_result (~100KB) through round-trip", () => {
    const dir = tmp()
    const store = SessionStore.open({ ...baseOpenOpts, sid: "ma-big", dir })
    const big = "x".repeat(100_000)
    store.appendToolResult({
      type: "tool_result",
      tool_use_id: "tu_big",
      content: big,
      is_error: false,
    })
    const lines = readJsonl(store.path)
    const t = lines[1] as ToolResultRecord
    expect(typeof t.content).toBe("string")
    expect((t.content as string).length).toBe(100_000)
  })
})

describe("parseLines", () => {
  it("returns all valid records and reports torn last line", () => {
    const dir = tmp()
    const path = sessionFilePath("ma-torn", dir)
    // valid meta + valid user + a partial line (no closing brace, no \n)
    const meta = JSON.stringify({
      kind: "meta",
      formatVersion: 1,
      sid: "ma-torn",
      createdAt: "2026-04-28T00:00:00Z",
      model: "m",
      cwd: "/x",
      systemHash: "h",
      toolsHash: "h",
      agentVersion: "v",
    })
    const user = JSON.stringify({ kind: "user", ts: "2026-04-28T00:00:01Z", content: "hi" })
    const torn = `{"kind":"assistant","ts":"2026`
    writeFileSync(path, `${meta}\n${user}\n${torn}`)
    const text = readFileSync(path, "utf-8")
    const { records, dropped } = parseLines(text)
    expect(records).toHaveLength(2)
    expect((records[0] as MetaRecord).kind).toBe("meta")
    expect((records[1] as UserRecord).kind).toBe("user")
    expect(dropped).toHaveLength(1)
    expect(dropped[0].line).toBe(3)
  })

  it("does not drop earlier records when a middle line is corrupt", () => {
    const meta = JSON.stringify({ kind: "meta", formatVersion: 1, sid: "x" })
    const bad = "{not json"
    const user = JSON.stringify({ kind: "user", ts: "t", content: "hi" })
    const { records, dropped } = parseLines(`${meta}\n${bad}\n${user}\n`)
    expect(records).toHaveLength(2)
    expect(dropped).toHaveLength(1)
    expect(dropped[0].line).toBe(2)
  })
})

describe("rewind records", () => {
  it("appendUser returns a stable id and writes it on the record", () => {
    const dir = tmp()
    const store = SessionStore.open({ ...baseOpenOpts, sid: "ma-rw-id", dir })
    const id = store.appendUser("hi")
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
    const lines = readJsonl(store.path)
    const u = lines[1] as UserRecord
    expect(u.kind).toBe("user")
    expect(u.id).toBe(id)
  })

  it("appendRewind writes a JSONL line that round-trips through parseLines", () => {
    const dir = tmp()
    const store = SessionStore.open({ ...baseOpenOpts, sid: "ma-rw-rt", dir })
    const id = store.appendUser("hello")
    store.appendRewind(id, 4)
    const text = readFileSync(store.path, "utf-8")
    const { records, dropped } = parseLines(text)
    expect(dropped).toHaveLength(0)
    const last = records[records.length - 1] as RewindRecord
    expect(last.kind).toBe("rewind")
    expect(last.to).toBe(id)
    expect(last.droppedCount).toBe(4)
    expect(typeof last.ts).toBe("string")
  })

  it("recordRewind is an alias for appendRewind", () => {
    const dir = tmp()
    const store = SessionStore.open({ ...baseOpenOpts, sid: "ma-rw-alias", dir })
    const id = store.appendUser("x")
    store.recordRewind(id, 2)
    const text = readFileSync(store.path, "utf-8")
    const { records } = parseLines(text)
    const last = records[records.length - 1] as RewindRecord
    expect(last.kind).toBe("rewind")
    expect(last.to).toBe(id)
    expect(last.droppedCount).toBe(2)
  })
})

describe("attach/detach records", () => {
  it("appendAttach writes a JSONL line that round-trips", () => {
    const dir = tmp()
    const sid = "ma-test-attach"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
    store.appendAttach(new Date("2026-02-02T03:04:05.000Z"))

    const recs = readJsonl(store.path) as Array<Record<string, unknown>>
    const att = recs.find((r) => r.kind === "attach") as Record<string, unknown> | undefined
    expect(att).toBeDefined()
    expect(att?.pid).toBe(process.pid)
    expect(typeof att?.hostname).toBe("string")
    expect(typeof att?.startTime).toBe("string")
    expect(att?.agentVersion).toBe("test")
    expect(att?.ts).toBe("2026-02-02T03:04:05.000Z")
  })

  it("appendDetach pairs with appendAttach by pid", () => {
    const dir = tmp()
    const sid = "ma-test-detach"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
    store.appendAttach(new Date("2026-02-02T03:04:05.000Z"))
    store.appendDetach("signal", undefined, new Date("2026-02-02T03:05:00.000Z"))

    const recs = readJsonl(store.path) as Array<Record<string, unknown>>
    const det = recs.find((r) => r.kind === "detach") as
      | (Record<string, unknown> & { pid: number; reason: string })
      | undefined
    expect(det).toBeDefined()
    expect(det?.pid).toBe(process.pid)
    expect(det?.reason).toBe("signal")
  })

  it("appendDetach is best-effort: throws are swallowed", () => {
    // Construct a store whose underlying path is a directory, so
    // appendFileSync will throw EISDIR. We verify appendDetach swallows.
    const dir = tmp()
    const sid = "ma-test-detach-fail"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
    // Replace the file with a directory to force write failure.
    const { unlinkSync, mkdirSync } = require("node:fs") as typeof import("node:fs")
    unlinkSync(store.path)
    mkdirSync(store.path)
    expect(() => store.appendDetach("error")).not.toThrow()
  })
})

describe("shortHash", () => {
  it("is deterministic and distinguishes inputs", () => {
    expect(shortHash("hello")).toBe(shortHash("hello"))
    expect(shortHash("hello")).not.toBe(shortHash("hello!"))
    expect(shortHash("")).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("SessionStore.fork", () => {
  // Set up a parent session with one of every preserved record kind plus a
  // pair of attach/detach records (which fork should DROP). Used by most
  // tests in this describe block.
  function seedParent(dir: string, srcSid: string) {
    const parent = SessionStore.open({ ...baseOpenOpts, sid: srcSid, dir })
    parent.appendAttach()
    const userId = parent.appendUser("first user prompt")
    parent.appendAssistant(
      [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "ls" } },
      ],
      "tool_use",
    )
    parent.appendToolResult({
      type: "tool_result",
      tool_use_id: "toolu_x",
      content: "ok",
      is_error: false,
    })
    parent.appendAssistant([{ type: "text", text: "done" }], "end_turn")
    parent.appendNote("free-form")
    parent.appendRewind(userId, 0)
    parent.appendDetach("exit", 0)
    return { parent, userId }
  }

  it("copies parent conversation records under a fresh meta with parentSid + forkedAt", () => {
    const dir = tmp()
    const srcSid = "ma-parent-A"
    const dstSid = "ma-fork-A"
    seedParent(dir, srcSid)

    const forkAt = new Date("2026-05-21T20:00:00.000Z")
    const fork = SessionStore.fork({
      ...baseOpenOpts,
      srcSid,
      dstSid,
      dir,
      now: () => forkAt,
    })

    const lines = readJsonl(fork.path)
    const kinds = lines.map((l) => (l as { kind: string }).kind)
    // meta + user + assistant + tool_result + assistant + note + rewind = 7
    // attach + detach from parent are DROPPED.
    expect(kinds).toEqual([
      "meta",
      "user",
      "assistant",
      "tool_result",
      "assistant",
      "note",
      "rewind",
    ])

    const meta = lines[0] as MetaRecord
    expect(meta.sid).toBe(dstSid)
    expect(meta.parentSid).toBe(srcSid)
    expect(meta.forkedAt).toBe(forkAt.toISOString())
    expect(meta.createdAt).toBe(forkAt.toISOString())
    expect(meta.model).toBe(baseOpenOpts.model)
    expect(meta.systemHash).toBe(baseOpenOpts.systemHash)
    expect(meta.toolsHash).toBe(baseOpenOpts.toolsHash)
  })

  it("preserves user record ids so subsequent rewinds still resolve", () => {
    const dir = tmp()
    const srcSid = "ma-parent-B"
    const dstSid = "ma-fork-B"
    const { userId } = seedParent(dir, srcSid)
    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })

    const forkLines = readJsonl(sessionFilePath(dstSid, dir))
    const user = forkLines.find((l) => (l as { kind: string }).kind === "user") as
      | UserRecord
      | undefined
    expect(user?.id).toBe(userId)
    const rewind = forkLines.find((l) => (l as { kind: string }).kind === "rewind") as
      | RewindRecord
      | undefined
    expect(rewind?.to).toBe(userId)
  })

  it("writes an index entry for the fork (so --resume last finds it)", () => {
    const dir = tmp()
    const srcSid = "ma-parent-C"
    const dstSid = "ma-fork-C"
    seedParent(dir, srcSid)
    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })

    const idxLines = readJsonl(indexFilePath(dir))
    expect(idxLines.length).toBe(2) // parent + fork
    const forkIdx = idxLines.find((l) => (l as IndexRecord).sid === dstSid) as
      | IndexRecord
      | undefined
    expect(forkIdx).toBeDefined()
    expect(forkIdx?.cwd).toBe(baseOpenOpts.cwd)
  })

  it("throws when destination exists and existsOk is false", () => {
    const dir = tmp()
    const srcSid = "ma-parent-D"
    const dstSid = "ma-fork-D"
    seedParent(dir, srcSid)
    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })
    expect(() => SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })).toThrow(
      /destination already exists/,
    )
  })

  it("throws ENOENT when parent does not exist", () => {
    const dir = tmp()
    expect(() =>
      SessionStore.fork({
        ...baseOpenOpts,
        srcSid: "ma-does-not-exist",
        dstSid: "ma-fork-E",
        dir,
      }),
    ).toThrow(/ENOENT|no such file/)
  })

  it("fork is non-destructive: parent file is byte-identical after fork", () => {
    const dir = tmp()
    const srcSid = "ma-parent-F"
    const dstSid = "ma-fork-F"
    seedParent(dir, srcSid)
    const parentBefore = readFileSync(sessionFilePath(srcSid, dir))
    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })
    const parentAfter = readFileSync(sessionFilePath(srcSid, dir))
    expect(parentAfter.equals(parentBefore)).toBe(true)
  })

  it("fork stamps the CURRENT (caller-supplied) hashes, not the parent's", () => {
    const dir = tmp()
    const srcSid = "ma-parent-G"
    const dstSid = "ma-fork-G"
    seedParent(dir, srcSid)
    SessionStore.fork({
      ...baseOpenOpts,
      srcSid,
      dstSid,
      dir,
      systemHash: "newsys00",
      toolsHash: "newtools",
    })
    const meta = readJsonl(sessionFilePath(dstSid, dir))[0] as MetaRecord
    expect(meta.systemHash).toBe("newsys00")
    expect(meta.toolsHash).toBe("newtools")
  })

  it("new turns appended to the fork do NOT leak into the parent file", () => {
    const dir = tmp()
    const srcSid = "ma-parent-H"
    const dstSid = "ma-fork-H"
    seedParent(dir, srcSid)
    const parentLinesBefore = readJsonl(sessionFilePath(srcSid, dir)).length
    const fork = SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })
    fork.appendAttach()
    fork.appendUser("new prompt on the fork")
    fork.appendAssistant([{ type: "text", text: "fork reply" }], "end_turn")
    const parentLinesAfter = readJsonl(sessionFilePath(srcSid, dir)).length
    expect(parentLinesAfter).toBe(parentLinesBefore)
  })

  it("forking an empty parent (meta only) succeeds and produces a meta-only fork", () => {
    const dir = tmp()
    const srcSid = "ma-parent-empty"
    const dstSid = "ma-fork-empty"
    SessionStore.open({ ...baseOpenOpts, sid: srcSid, dir })
    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })
    const lines = readJsonl(sessionFilePath(dstSid, dir))
    expect(lines.length).toBe(1)
    expect((lines[0] as MetaRecord).kind).toBe("meta")
    expect((lines[0] as MetaRecord).parentSid).toBe(srcSid)
  })

  it("fork chains: forking a fork records the immediate parent only", () => {
    const dir = tmp()
    const sidA = "ma-A"
    const sidB = "ma-B"
    const sidC = "ma-C"
    seedParent(dir, sidA)
    SessionStore.fork({ ...baseOpenOpts, srcSid: sidA, dstSid: sidB, dir })
    SessionStore.fork({ ...baseOpenOpts, srcSid: sidB, dstSid: sidC, dir })
    const metaC = readJsonl(sessionFilePath(sidC, dir))[0] as MetaRecord
    expect(metaC.parentSid).toBe(sidB)
    expect(metaC.sid).toBe(sidC)
  })
})

describe("MetaRecord (parentSid / forkedAt)", () => {
  it("a vanilla open() produces meta WITHOUT parentSid / forkedAt", () => {
    const dir = tmp()
    const store = SessionStore.open({ ...baseOpenOpts, sid: "ma-plain", dir })
    const meta = readJsonl(store.path)[0] as MetaRecord
    expect(meta.parentSid).toBeUndefined()
    expect(meta.forkedAt).toBeUndefined()
  })

  it("old session files (no parentSid field) still parse cleanly", () => {
    // Hand-craft a pre-fork-feature meta record on disk and verify
    // parseLines accepts it without choking.
    const dir = tmp()
    const sid = "ma-legacy"
    const path = join(dir, `${sid}.jsonl`)
    const legacyMeta = {
      kind: "meta",
      formatVersion: 1,
      sid,
      createdAt: "2026-01-01T00:00:00.000Z",
      model: "claude-sonnet-4-6",
      cwd: "/tmp",
      systemHash: "deadbeef",
      toolsHash: "cafebabe",
      agentVersion: "legacy",
    }
    writeFileSync(path, `${JSON.stringify(legacyMeta)}\n`)
    const { records, dropped } = parseLines(readFileSync(path, "utf-8"))
    expect(dropped).toHaveLength(0)
    expect(records).toHaveLength(1)
    expect((records[0] as MetaRecord).sid).toBe(sid)
  })
})

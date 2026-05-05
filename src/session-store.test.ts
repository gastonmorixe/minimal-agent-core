import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AssistantRecord,
  indexFilePath,
  type IndexRecord,
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

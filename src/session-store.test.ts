import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

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

  // Underpins the `--resume-same-sid` flag: resuming in place reopens the
  // SAME file with existsOk:true. open() must NOT rewrite the meta record
  // even when the resuming process advertises a different model / prompt /
  // tool set, otherwise the on-disk session history would gain a second
  // meta line and the original creation metadata would be lost. The guard
  // is the `if (!fileExists)` block: on an existing file open() writes
  // nothing up front and only the append*() calls add records.
  it("preserves the original meta on same-sid reopen even when resume opts differ", () => {
    const dir = tmp()
    const sid = "ma-same-sid"
    const first = SessionStore.open({
      ...baseOpenOpts,
      sid,
      dir,
      model: "model-A",
      systemHash: "sysA",
      toolsHash: "toolA",
    })
    first.appendUser("original prompt")

    // Reopen the same sid in place with a DIFFERENT model + hashes.
    const second = SessionStore.open({
      ...baseOpenOpts,
      sid,
      dir,
      model: "model-B",
      systemHash: "sysB",
      toolsHash: "toolB",
      existsOk: true,
    })
    second.appendUser("resumed prompt")

    const lines = readJsonl(second.path)
    // meta + 2 user records, exactly one meta line.
    expect(lines).toHaveLength(3)
    expect(lines.filter((l) => (l as { kind: string }).kind === "meta")).toHaveLength(1)

    const meta = lines[0] as MetaRecord
    expect(meta.kind).toBe("meta")
    // Original creation metadata wins; the resume opts are ignored for meta.
    expect(meta.model).toBe("model-A")
    expect(meta.systemHash).toBe("sysA")
    expect(meta.toolsHash).toBe("toolA")

    // Both turns landed, in write order, on the one file.
    expect((lines[1] as { kind: string }).kind).toBe("user")
    expect((lines[2] as { kind: string }).kind).toBe("user")

    // Reopening must not have written a duplicate index entry either.
    const indexLines = readJsonl(indexFilePath(dir))
    expect(indexLines.filter((l) => (l as IndexRecord).sid === sid)).toHaveLength(1)
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

  // Regression: --resume used to drop plugin-driven `display` /
  // `displayHeader` / `displayFooter` because the store never persisted
  // them. With the fix, all three round-trip when supplied via the
  // optional `presentation` arg.
  it("persists display/displayHeader/displayFooter on tool_result when supplied", () => {
    const dir = tmp()
    const store = SessionStore.open({ ...baseOpenOpts, sid: "ma-display", dir })
    store.appendToolResult(
      {
        type: "tool_result",
        tool_use_id: "tu_edit",
        content: "File edited: /x.json (1 replacement(s))",
        is_error: false,
      },
      undefined,
      undefined,
      {
        display: "--- a\n+++ b\n-old\n+new",
        displayHeader: "✦ summary",
        displayFooter: "1 hunk",
      },
    )
    const lines = readJsonl(store.path)
    const t = lines[1] as ToolResultRecord
    expect(t.kind).toBe("tool_result")
    expect(t.display).toBe("--- a\n+++ b\n-old\n+new")
    expect(t.displayHeader).toBe("✦ summary")
    expect(t.displayFooter).toBe("1 hunk")
  })

  it("omits display fields entirely when the presentation arg is not supplied (back-compat)", () => {
    // Old-style call (no presentation arg). The JSONL line must NOT
    // grow new keys, so existing session readers see byte-identical
    // records.
    const dir = tmp()
    const store = SessionStore.open({ ...baseOpenOpts, sid: "ma-no-display", dir })
    store.appendToolResult({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "ok",
      is_error: false,
    })
    const lines = readJsonl(store.path)
    const t = lines[1] as ToolResultRecord
    expect(t.display).toBeUndefined()
    expect(t.displayHeader).toBeUndefined()
    expect(t.displayFooter).toBeUndefined()
    // The serialized JSON must not contain the keys at all (so resume
    // of an OLD session file produces the same JSON byte-for-byte).
    const raw = readFileSync(store.path, "utf-8")
    expect(raw).not.toContain('"display"')
    expect(raw).not.toContain('"displayHeader"')
    expect(raw).not.toContain('"displayFooter"')
  })

  it("partial presentation (just `display`) only emits the populated key", () => {
    const dir = tmp()
    const store = SessionStore.open({ ...baseOpenOpts, sid: "ma-partial", dir })
    store.appendToolResult(
      { type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false },
      undefined,
      undefined,
      { display: "rendered" },
    )
    const lines = readJsonl(store.path)
    const t = lines[1] as ToolResultRecord
    expect(t.display).toBe("rendered")
    expect(t.displayHeader).toBeUndefined()
    expect(t.displayFooter).toBeUndefined()
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

  // ---------------------------------------------------------------------
  // Sidecar duplication on fork
  //
  // Per-sid sidecars (tasks, short-term scratch, draft, future plugins)
  // are addressed at runtime by the CURRENT sid. Without copying them
  // across the fork, a resumed session reads from an empty sidecar even
  // though the JSONL it just forked references the prior state. The
  // user-visible symptom is `Task({action: "done", id: N})` returning
  // "id N not found" right after resume.
  // ---------------------------------------------------------------------

  it("copies per-sid sidecar files (tasks/scratch/draft) to the new sid", () => {
    const dir = tmp()
    const srcSid = "ma-parent-side-A"
    const dstSid = "ma-fork-side-A"
    seedParent(dir, srcSid)

    // Plant one of each well-known sidecar shape, plus a generic one
    // to prove the rule is suffix-agnostic.
    const tasksBody = `{"id":"abc123","title":"do the thing","status":"todo"}\n`
    const scratchBody = "[2026-05-25T16:51:56-04:00] note one\n"
    const draftBody = "in-progress prompt text"
    const futureBody = "anything keyed by sid"
    writeFileSync(join(dir, `${srcSid}.tasks.jsonl`), tasksBody)
    writeFileSync(join(dir, `${srcSid}.scratch.md`), scratchBody)
    writeFileSync(join(dir, `${srcSid}.draft`), draftBody)
    writeFileSync(join(dir, `${srcSid}.future-plugin.bin`), futureBody)

    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })

    // Each sidecar should now exist under the new sid with identical bytes.
    expect(readFileSync(join(dir, `${dstSid}.tasks.jsonl`), "utf-8")).toBe(tasksBody)
    expect(readFileSync(join(dir, `${dstSid}.scratch.md`), "utf-8")).toBe(scratchBody)
    expect(readFileSync(join(dir, `${dstSid}.draft`), "utf-8")).toBe(draftBody)
    expect(readFileSync(join(dir, `${dstSid}.future-plugin.bin`), "utf-8")).toBe(futureBody)

    // Parent sidecars must remain in place (fork is non-destructive).
    expect(existsSync(join(dir, `${srcSid}.tasks.jsonl`))).toBe(true)
    expect(existsSync(join(dir, `${srcSid}.scratch.md`))).toBe(true)
    expect(existsSync(join(dir, `${srcSid}.draft`))).toBe(true)
  })

  it("does NOT copy the parent's blob directory (blobs survive resume by absolute path)", () => {
    const dir = tmp()
    const srcSid = "ma-parent-side-B"
    const dstSid = "ma-fork-side-B"
    seedParent(dir, srcSid)

    // Plant a `<srcSid>.blobs/` directory with a fake blob inside.
    const blobsDir = join(dir, `${srcSid}.blobs`)
    mkdirSync(blobsDir, { recursive: true })
    writeFileSync(join(blobsDir, "toolu_x.raw"), "raw bytes")

    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })

    // The new sid must NOT have a sibling blob directory: blobs are
    // referenced via absolute paths inside the conversation log, which
    // still point at the parent's `<srcSid>.blobs/`. Copying them
    // would waste disk and create stale duplicates.
    expect(existsSync(join(dir, `${dstSid}.blobs`))).toBe(false)
    // Parent blob dir remains untouched.
    expect(existsSync(blobsDir)).toBe(true)
  })

  it("does not touch sidecars belonging to unrelated sessions in the same dir", () => {
    const dir = tmp()
    const srcSid = "ma-parent-side-C"
    const dstSid = "ma-fork-side-C"
    const otherSid = "ma-unrelated-side-C"
    seedParent(dir, srcSid)

    writeFileSync(join(dir, `${srcSid}.tasks.jsonl`), "source\n")
    writeFileSync(join(dir, `${otherSid}.tasks.jsonl`), "untouched\n")

    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })

    // Other-session sidecar must be byte-identical after the fork.
    expect(readFileSync(join(dir, `${otherSid}.tasks.jsonl`), "utf-8")).toBe("untouched\n")
    // And the dst sidecar exists and matches the source.
    expect(readFileSync(join(dir, `${dstSid}.tasks.jsonl`), "utf-8")).toBe("source\n")
  })

  it("fork succeeds when the parent has no sidecars at all", () => {
    const dir = tmp()
    const srcSid = "ma-parent-side-D"
    const dstSid = "ma-fork-side-D"
    seedParent(dir, srcSid)
    // No sidecars planted. fork should still complete without throwing.
    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })
    // And no sidecars should magically appear under the dst sid.
    expect(existsSync(join(dir, `${dstSid}.tasks.jsonl`))).toBe(false)
    expect(existsSync(join(dir, `${dstSid}.scratch.md`))).toBe(false)
    expect(existsSync(join(dir, `${dstSid}.draft`))).toBe(false)
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

  it("open() stores provider when passed", () => {
    const dir = tmp()
    const store = SessionStore.open({
      ...baseOpenOpts,
      sid: "ma-provider-open",
      dir,
      provider: "opencode",
    })
    const meta = readJsonl(store.path)[0] as MetaRecord
    expect(meta.provider).toBe("opencode")
  })

  it("open() omits provider when not passed (backward compat)", () => {
    const dir = tmp()
    const store = SessionStore.open({ ...baseOpenOpts, sid: "ma-no-provider-open", dir })
    const meta = readJsonl(store.path)[0] as MetaRecord
    expect(meta.provider).toBeUndefined()
  })

  it("fork() stores provider when passed", () => {
    const dir = tmp()
    const srcSid = "ma-provider-fork-src"
    const dstSid = "ma-provider-fork-dst"
    SessionStore.open({ ...baseOpenOpts, sid: srcSid, dir })
    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir, provider: "opencode" })
    const meta = readJsonl(sessionFilePath(dstSid, dir))[0] as MetaRecord
    expect(meta.provider).toBe("opencode")
  })

  it("fork() omits provider when not passed (backward compat)", () => {
    const dir = tmp()
    const srcSid = "ma-no-provider-fork-src"
    const dstSid = "ma-no-provider-fork-dst"
    SessionStore.open({ ...baseOpenOpts, sid: srcSid, dir })
    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })
    const meta = readJsonl(sessionFilePath(dstSid, dir))[0] as MetaRecord
    expect(meta.provider).toBeUndefined()
  })

  it("old session files (no provider field) still parse cleanly (backward compat)", () => {
    const dir = tmp()
    const sid = "ma-legacy-provider"
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
    expect((records[0] as MetaRecord).provider).toBeUndefined()
  })
})

describe("SessionStore.cleanupIfUnused", () => {
  it("removes the JSONL log, index entry, and sidecars on a never-used session", () => {
    const dir = tmp()
    const sid = "ma-unused-A"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })

    // Plant a few sidecars + a blob directory, the way the tasks/memory
    // plugins and blob store would create them lazily during a real run.
    writeFileSync(join(dir, `${sid}.tasks.jsonl`), "{}\n")
    writeFileSync(join(dir, `${sid}.scratch.md`), "scratch\n")
    writeFileSync(join(dir, `${sid}.draft`), "draft body")
    mkdirSync(join(dir, `${sid}.blobs`), { recursive: true })
    writeFileSync(join(dir, `${sid}.blobs`, "toolu_x.raw"), "raw")

    // Process-bookkeeping records do NOT count as conversation.
    store.appendAttach()
    store.appendDetach("exit", 0)

    const cleaned = store.cleanupIfUnused()
    expect(cleaned).toBe(true)

    // JSONL gone.
    expect(existsSync(store.path)).toBe(false)
    // Sidecars gone.
    expect(existsSync(join(dir, `${sid}.tasks.jsonl`))).toBe(false)
    expect(existsSync(join(dir, `${sid}.scratch.md`))).toBe(false)
    expect(existsSync(join(dir, `${sid}.draft`))).toBe(false)
    // Blob dir gone.
    expect(existsSync(join(dir, `${sid}.blobs`))).toBe(false)
    // Index entry gone.
    const idxRaw = readFileSync(indexFilePath(dir), "utf-8")
    expect(idxRaw).toBe("")
  })

  it("preserves a session that recorded any conversation", () => {
    const dir = tmp()
    const sid = "ma-used"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
    store.appendUser("hello")

    const cleaned = store.cleanupIfUnused()
    expect(cleaned).toBe(false)
    expect(existsSync(store.path)).toBe(true)
    const idxLines = readJsonl(indexFilePath(dir))
    expect(idxLines).toHaveLength(1)
    expect((idxLines[0] as IndexRecord).sid).toBe(sid)
  })

  it("treats attach/detach alone as 'unused' (process bookkeeping only)", () => {
    const dir = tmp()
    const sid = "ma-attach-only"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
    store.appendAttach()
    expect(store.cleanupIfUnused()).toBe(true)
    expect(existsSync(store.path)).toBe(false)
  })

  it("each conversation-shaped append flips hasConversation", () => {
    // One sub-case per append* method, isolated to confirm the flag is
    // not accidentally tied to a specific method (e.g. only appendUser).
    const cases: Array<[string, (s: SessionStore) => void]> = [
      ["user", (s) => s.appendUser("u")],
      ["assistant", (s) => s.appendAssistant([{ type: "text", text: "a" }], "end_turn")],
      [
        "tool_result",
        (s) =>
          s.appendToolResult({
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "x",
            is_error: false,
          }),
      ],
      ["note", (s) => s.appendNote("n")],
      [
        "rewind",
        (s) => {
          const id = s.appendUser("u")
          s.appendRewind(id, 0)
        },
      ],
    ]
    for (const [label, mutate] of cases) {
      const dir = tmp()
      const sid = `ma-flag-${label}`
      const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
      mutate(store)
      expect(store.cleanupIfUnused()).toBe(false)
      expect(existsSync(store.path)).toBe(true)
    }
  })

  it("a fork inherits hasConversation from the parent's records", () => {
    // Resume-and-immediately-quit must NOT delete the resumed session
    // file. The parent had real conversation; the fork's `hasConversation`
    // is pre-seeded from that, so cleanupIfUnused() is a no-op even with
    // zero new appends.
    const dir = tmp()
    const srcSid = "ma-cleanup-src"
    const dstSid = "ma-cleanup-dst"
    const parent = SessionStore.open({ ...baseOpenOpts, sid: srcSid, dir })
    parent.appendUser("first user prompt")
    parent.appendAssistant([{ type: "text", text: "hi" }], "end_turn")

    const fork = SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })
    // No new appends on the fork at all — but the inherited records
    // should still mark it as "used".
    expect(fork.cleanupIfUnused()).toBe(false)
    expect(existsSync(fork.path)).toBe(true)
  })

  it("an empty fork (meta-only parent) is still eligible for cleanup", () => {
    // The complementary case: forking a parent that itself had no
    // conversation produces a fork that also has no conversation, so
    // cleanup runs.
    const dir = tmp()
    const srcSid = "ma-empty-src"
    const dstSid = "ma-empty-dst"
    SessionStore.open({ ...baseOpenOpts, sid: srcSid, dir })
    const fork = SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })
    expect(fork.cleanupIfUnused()).toBe(true)
    expect(existsSync(fork.path)).toBe(false)
  })

  it("only touches the target sid's rows in index.jsonl", () => {
    // Two sessions side by side. Cleaning up the unused one must NOT
    // disturb the other's index entry.
    const dir = tmp()
    const used = SessionStore.open({ ...baseOpenOpts, sid: "ma-keep-side", dir })
    used.appendUser("real prompt")
    const unused = SessionStore.open({ ...baseOpenOpts, sid: "ma-drop-side", dir })

    expect(unused.cleanupIfUnused()).toBe(true)

    const idxLines = readJsonl(indexFilePath(dir)) as IndexRecord[]
    expect(idxLines).toHaveLength(1)
    expect(idxLines[0].sid).toBe("ma-keep-side")
  })

  it("is idempotent: a second call is a no-op", () => {
    const dir = tmp()
    const sid = "ma-idempotent"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })

    expect(store.cleanupIfUnused()).toBe(true)
    // File is already gone; calling again must not throw and must still
    // report success (the session remains unused).
    expect(() => store.cleanupIfUnused()).not.toThrow()
  })
})

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { firstUserPromptSnippet, foldRecords, loadSession } from "./session-restore.ts"
import { type SessionRecord, SessionStore } from "./session-store.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ma-session-restore-"))
}

const baseOpenOpts = {
  // Neutral fake id: the model is opaque to these tests, and the
  // provider-decoupling ratchet forbids provider tokens in new core files.
  model: "test-model-1",
  cwd: "/tmp/example",
  systemHash: "deadbeef",
  toolsHash: "cafebabe",
  agentVersion: "test",
}

describe("foldRecords (rewind)", () => {
  it("single rewind drops post-target records", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t1", content: "first", id: "u1" },
      {
        kind: "assistant",
        ts: "t1",
        content: [{ type: "text", text: "ans1" }],
        stopReason: "end_turn",
      },
      { kind: "user", ts: "t2", content: "second", id: "u2" },
      {
        kind: "assistant",
        ts: "t2",
        content: [{ type: "text", text: "ans2" }],
        stopReason: "end_turn",
      },
      { kind: "rewind", ts: "t3", to: "u1", droppedCount: 3 },
    ]
    const messages = foldRecords(records)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("user")
    expect(messages[0].content).toBe("first")
  })

  it("multiple rewinds compose", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t1", content: "first", id: "u1" },
      { kind: "user", ts: "t2", content: "second", id: "u2" },
      { kind: "rewind", ts: "t3", to: "u1", droppedCount: 1 },
      { kind: "user", ts: "t4", content: "third", id: "u3" },
      { kind: "rewind", ts: "t5", to: "u1", droppedCount: 1 },
    ]
    const messages = foldRecords(records)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe("first")
  })

  it("rewind with unknown `to` id is skipped (no crash)", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t1", content: "hi", id: "u1" },
      { kind: "rewind", ts: "t2", to: "does-not-exist", droppedCount: 0 },
      {
        kind: "assistant",
        ts: "t3",
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
      },
    ]
    const messages = foldRecords(records)
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe("hi")
    expect(messages[1].role).toBe("assistant")
  })

  it("rewind preserves merged tool_result blocks on the kept user message", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t0", content: "go", id: "u0" },
      {
        kind: "assistant",
        ts: "t0",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} }],
        stopReason: "tool_use",
      },
      { kind: "tool_result", ts: "t0", tool_use_id: "tu_1", content: "ok", isError: false },
      { kind: "user", ts: "t1", content: "next", id: "u1" },
      { kind: "rewind", ts: "t2", to: "u0", droppedCount: 3 },
    ]
    const messages = foldRecords(records)
    // u0 user, asst(tool_use), user(tool_result merged) — kept up through targetIdx=0
    // Wait: target is u0 at index 0; everything after is dropped.
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe("go")
  })
})

describe("firstUserPromptSnippet", () => {
  it("returns the first user message text trimmed and one-line", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t", content: "  hello\nworld   " },
      { kind: "user", ts: "t", content: "ignored" },
    ]
    expect(firstUserPromptSnippet(records)).toBe("hello world")
  })
  it("truncates with ellipsis", () => {
    const long = "x".repeat(100)
    const records: SessionRecord[] = [{ kind: "user", ts: "t", content: long }]
    const out = firstUserPromptSnippet(records, 20)
    expect(out.length).toBe(20)
    expect(out.endsWith("...")).toBe(true)
  })
  it("handles content blocks (text)", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t", content: [{ type: "text", text: "blocky hi" }] },
    ]
    expect(firstUserPromptSnippet(records)).toBe("blocky hi")
  })
})

// ---------------------------------------------------------------------------
// Fork round-trip: parent → SessionStore.fork() → loadSession(fork) must
// reproduce the same conversation messages. This is the end-to-end guard
// that protects the user-visible promise: "--resume <fork-sid>" yields the
// same conversation as "--resume <parent-sid>" (minus any fork-time
// content drift, which there is none of in this test).
// ---------------------------------------------------------------------------

describe("loadSession(fork) round-trip", () => {
  it("a fork yields the same messages as its parent", () => {
    const dir = tmp()
    const srcSid = "ma-restore-parent"
    const dstSid = "ma-restore-fork"
    const parent = SessionStore.open({ ...baseOpenOpts, sid: srcSid, dir })
    parent.appendAttach()
    parent.appendUser("hello")
    parent.appendAssistant(
      [
        { type: "text", text: "world" },
        { type: "tool_use", id: "toolu_y", name: "Bash", input: { command: "echo hi" } },
      ],
      "tool_use",
    )
    parent.appendToolResult({
      type: "tool_result",
      tool_use_id: "toolu_y",
      content: "hi",
      is_error: false,
    })
    parent.appendAssistant([{ type: "text", text: "done" }], "end_turn")
    parent.appendDetach("exit", 0)

    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })

    const parentLoad = loadSession(srcSid, dir)
    const forkLoad = loadSession(dstSid, dir)
    // Same conversation, byte-identical message JSON.
    expect(JSON.stringify(forkLoad.messages)).toBe(JSON.stringify(parentLoad.messages))
    // Fork's meta carries the parent pointer; parent's meta has neither.
    expect(forkLoad.meta?.parentSid).toBe(srcSid)
    expect(forkLoad.meta?.forkedAt).toBeDefined()
    expect(parentLoad.meta?.parentSid).toBeUndefined()
    expect(parentLoad.meta?.forkedAt).toBeUndefined()
  })

  it("rewinds in the parent fold correctly through the fork", () => {
    const dir = tmp()
    const srcSid = "ma-restore-rewind-parent"
    const dstSid = "ma-restore-rewind-fork"
    const parent = SessionStore.open({ ...baseOpenOpts, sid: srcSid, dir })
    const id1 = parent.appendUser("first")
    parent.appendAssistant([{ type: "text", text: "ans1" }], "end_turn")
    parent.appendUser("second")
    parent.appendAssistant([{ type: "text", text: "ans2" }], "end_turn")
    parent.appendRewind(id1, 3)
    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })

    const forkLoad = loadSession(dstSid, dir)
    // Rewind keeps the prompt with id=id1; everything after is dropped.
    expect(forkLoad.messages).toHaveLength(1)
    expect(forkLoad.messages[0]?.role).toBe("user")
  })
})

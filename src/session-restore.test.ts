import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "./client.ts"
import {
  firstUserPromptSnippet,
  foldRecords,
  loadSession,
  loadSessionFromText,
  repairTrailingTurn,
} from "./session-restore.ts"
import { type SessionRecord, SessionStore } from "./session-store.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ma-session-restore-"))
}

const baseOpenOpts = {
  model: "claude-sonnet-4-6",
  cwd: "/tmp/example",
  systemHash: "deadbeef",
  toolsHash: "cafebabe",
  agentVersion: "test",
}

describe("foldRecords", () => {
  it("folds a clean turn (user → assistant text)", () => {
    const records: SessionRecord[] = [
      {
        kind: "meta",
        formatVersion: 1,
        sid: "x",
        createdAt: "t",
        model: "m",
        cwd: "/x",
        systemHash: "h",
        toolsHash: "h",
        agentVersion: "v",
      },
      { kind: "user", ts: "t", content: "hello" },
      {
        kind: "assistant",
        ts: "t",
        content: [{ type: "text", text: "hi" }],
        stopReason: "end_turn",
      },
    ]
    const messages = foldRecords(records)
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("user")
    expect(messages[0].content).toBe("hello")
    expect(messages[1].role).toBe("assistant")
  })

  it("merges multiple tool_results into a single user turn", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t", content: "do stuff" },
      {
        kind: "assistant",
        ts: "t",
        content: [
          { type: "tool_use", id: "tu_1", name: "Bash", input: {} },
          { type: "tool_use", id: "tu_2", name: "Bash", input: {} },
        ],
        stopReason: "tool_use",
      },
      { kind: "tool_result", ts: "t", tool_use_id: "tu_1", content: "ok1", isError: false },
      { kind: "tool_result", ts: "t", tool_use_id: "tu_2", content: "ok2", isError: false },
    ]
    const messages = foldRecords(records)
    expect(messages).toHaveLength(3)
    const trailing = messages[2]
    expect(trailing.role).toBe("user")
    expect(Array.isArray(trailing.content)).toBe(true)
    const blocks = trailing.content as ToolResultBlock[]
    expect(blocks).toHaveLength(2)
    expect(blocks[0].tool_use_id).toBe("tu_1")
    expect(blocks[1].tool_use_id).toBe("tu_2")
  })

  it("skips meta and note records", () => {
    const records: SessionRecord[] = [
      {
        kind: "meta",
        formatVersion: 1,
        sid: "x",
        createdAt: "t",
        model: "m",
        cwd: "/x",
        systemHash: "h",
        toolsHash: "h",
        agentVersion: "v",
      },
      { kind: "note", ts: "t", text: "hello world" },
      { kind: "user", ts: "t", content: "hi" },
    ]
    expect(foldRecords(records)).toHaveLength(1)
  })
})

describe("repairTrailingTurn", () => {
  it("drops a trailing assistant turn with unmatched tool_use", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running..." },
          { type: "tool_use", id: "tu_orphan", name: "Bash", input: {} } as ToolUseBlock,
        ],
      },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(1)
    expect(repaired[0].role).toBe("user")
  })

  it("preserves trailing user-with-tool_results when matched by previous assistant", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} } as ToolUseBlock],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "ok",
            is_error: false,
          } as ToolResultBlock,
        ],
      },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(3)
  })

  it("preserves a clean end_turn assistant", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    expect(repairTrailingTurn(messages)).toHaveLength(2)
  })

  it("is idempotent on already-valid input", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    const once = repairTrailingTurn(messages)
    const twice = repairTrailingTurn(once)
    expect(twice).toEqual(once)
  })

  it("handles cascading drops (assistant tool_use, no result, assistant tool_use again)", () => {
    const messages: Message[] = [
      { role: "user", content: "a" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_a", name: "Bash", input: {} } as ToolUseBlock],
      },
      // missing tool_result for tu_a — invalid — but somehow another assistant got appended:
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_b", name: "Bash", input: {} } as ToolUseBlock],
      },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(1)
    expect(repaired[0].role).toBe("user")
  })

  it("reorders user message blocks so tool_result comes first (Bug: API requires tool_result immediately after tool_use)", () => {
    // Repro: a queued user submit's appendUser landed BETWEEN the assistant's
    // appendAssistant and the for-tools loop's appendToolResult. foldRecords
    // then attached the tool_result onto the existing `[text]` user message,
    // producing `[text, tool_result]`. Anthropic API rejects this with
    // "tool_use ids were found without tool_result blocks immediately after".
    const messages: Message[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_x",
            name: "Bash",
            input: { command: "echo" },
          } as ToolUseBlock,
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "queued by user mid-turn" },
          {
            type: "tool_result",
            tool_use_id: "tu_x",
            content: "out",
            is_error: false,
          } as ToolResultBlock,
        ],
      },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(3)
    const userMsg = repaired[2]
    expect(userMsg.role).toBe("user")
    expect(Array.isArray(userMsg.content)).toBe(true)
    const blocks = userMsg.content as ContentBlock[]
    // tool_result MUST be first.
    expect(blocks[0].type).toBe("tool_result")
    expect((blocks[0] as ToolResultBlock).tool_use_id).toBe("tu_x")
    expect(blocks[1].type).toBe("text")
  })

  it("drops a trailing user message whose tool_results have no matching tool_use", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_dangling",
            content: "ghost",
            is_error: false,
          } as ToolResultBlock,
        ],
      },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(2)
  })
})

describe("loadSession (full pipeline)", () => {
  it("round-trips a real SessionStore session via loadSession", () => {
    const dir = tmp()
    const sid = "ma-roundtrip"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
    store.appendUser("read package.json")
    store.appendAssistant(
      [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "package.json" } }],
      "tool_use",
    )
    store.appendToolResult({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: '{"name":"x"}',
      is_error: false,
    })
    store.appendAssistant([{ type: "text", text: "It's named x." }], "end_turn")

    const loaded = loadSession(sid, dir)
    expect(loaded.dropped).toHaveLength(0)
    expect(loaded.repaired).toBe(false)
    expect(loaded.meta?.sid).toBe(sid)
    expect(loaded.messages).toHaveLength(4) // user, asst(tool_use), user(tool_result), asst(text)
    expect(loaded.messages[3].role).toBe("assistant")
  })

  it("repairs a crashed-mid-tool session (tool_use without tool_result)", () => {
    const dir = tmp()
    const sid = "ma-crashed"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
    store.appendUser("do thing")
    store.appendAssistant(
      [{ type: "tool_use", id: "tu_x", name: "Bash", input: { command: "sleep 9999" } }],
      "tool_use",
    )
    // — agent crashed here, no tool_result was ever written —

    const loaded = loadSession(sid, dir)
    expect(loaded.repaired).toBe(true)
    expect(loaded.messages).toHaveLength(1)
    expect(loaded.messages[0].role).toBe("user")
  })

  it("tolerates a torn last line (kill -9 mid-write) without losing prior turns", () => {
    const meta = JSON.stringify({
      kind: "meta",
      formatVersion: 1,
      sid: "ma-torn",
      createdAt: "t",
      model: "m",
      cwd: "/x",
      systemHash: "h",
      toolsHash: "h",
      agentVersion: "v",
    })
    const user = JSON.stringify({ kind: "user", ts: "t", content: "hello" })
    const torn = `{"kind":"assistant","ts":"t","conten` // truncated
    const text = `${meta}\n${user}\n${torn}`
    const loaded = loadSessionFromText(text)
    expect(loaded.dropped).toHaveLength(1)
    expect(loaded.messages).toHaveLength(1)
    expect(loaded.messages[0].content).toBe("hello")
  })
})

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

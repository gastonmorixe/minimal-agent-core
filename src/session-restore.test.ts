import { describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message, ToolResultBlock, ToolUseBlock } from "./client.ts"
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
          { type: "text", text: "running…" },
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
    expect(out.endsWith("…")).toBe(true)
  })
  it("handles content blocks (text)", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t", content: [{ type: "text", text: "blocky hi" }] },
    ]
    expect(firstUserPromptSnippet(records)).toBe("blocky hi")
  })
})

/**
 * Unit tests for the extracted history-repair helpers.
 *
 * `Agent.rollbackPendingTurn()` and `Agent.repairOrphanedToolUse()` delegate to
 * these. The Agent-level behavior is covered end-to-end in src/agent.test.ts;
 * here we pin the pure functions directly so the extraction has its own guard.
 */

import { describe, expect, it } from "bun:test"

import type { Message, ToolResultBlock } from "../client.ts"

import {
  repairOrphanedToolUse,
  rollbackPendingTurn,
  type ToolResultSink,
} from "./history-repair.ts"

describe("rollbackPendingTurn", () => {
  it("pops a trailing plain-text user message", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "pending" }] },
    ]
    expect(rollbackPendingTurn(messages)).toBe(true)
    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe("assistant")
  })

  it("refuses to discard a user message carrying tool_result blocks", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok", is_error: false }],
      },
    ]
    expect(rollbackPendingTurn(messages)).toBe(false)
    expect(messages.length).toBe(2)
  })

  it("returns false (and no-ops) when history ends on an assistant turn", () => {
    const messages: Message[] = [{ role: "assistant", content: [{ type: "text", text: "done" }] }]
    expect(rollbackPendingTurn(messages)).toBe(false)
    expect(messages.length).toBe(1)
  })
})

describe("repairOrphanedToolUse", () => {
  it("synthesizes is_error tool_result blocks for orphaned tool_use", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } }],
      },
    ]
    const sunk: ToolResultBlock[] = []
    const store: ToolResultSink = { appendToolResult: (b) => sunk.push(b) }

    const blocks = repairOrphanedToolUse(messages, store)

    expect(blocks.length).toBe(1)
    expect(blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "call-1", is_error: true })
    // Persisted to the store exactly once, and does NOT mutate `messages`.
    expect(sunk.length).toBe(1)
    expect(messages.length).toBe(2)
  })

  it("returns [] when the trailing assistant turn has no tool_use", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "just text" }] },
    ]
    expect(repairOrphanedToolUse(messages, null)).toEqual([])
  })

  it("returns [] when history is empty or does not end on an assistant turn", () => {
    expect(repairOrphanedToolUse([], null)).toEqual([])
    expect(
      repairOrphanedToolUse([{ role: "user", content: [{ type: "text", text: "x" }] }], null),
    ).toEqual([])
  })

  it("tolerates a null store (no persistence, still returns blocks)", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-9", name: "Read", input: {} }],
      },
    ]
    const blocks = repairOrphanedToolUse(messages, null)
    expect(blocks.length).toBe(1)
    expect(blocks[0].tool_use_id).toBe("call-9")
  })
})

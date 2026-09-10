/**
 * Unit tests for shared context-compaction helpers (Agent + AgentCore).
 */
import { describe, expect, it } from "bun:test"

import type { Message } from "../llm/messages.ts"

import {
  buildLocalCompactMessages,
  buildReplacementHistory,
  COMPACTION_USER_MARKER,
  extractPendingUserText,
  flattenHistoryForSummary,
  replaceMessagesInPlace,
} from "./context-compact.ts"

describe("replaceMessagesInPlace", () => {
  it("clears and repopulates the same array reference", () => {
    const messages: Message[] = [{ role: "user", content: "a" }]
    const next: Message[] = [
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
    ]
    replaceMessagesInPlace(messages, next)
    expect(messages).toEqual(next)
    expect(messages.length).toBe(2)
  })
})

describe("buildReplacementHistory", () => {
  it("maps portable rows to block-shaped Message[]", () => {
    const out = buildReplacementHistory([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ])
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ])
  })
})

describe("buildLocalCompactMessages", () => {
  it("prepends a checkpoint and keeps a short tail", () => {
    const previous: Message[] = []
    for (let i = 0; i < 20; i++) {
      previous.push({ role: "user", content: `u${i}` })
      previous.push({ role: "assistant", content: `a${i}` })
    }
    const next = buildLocalCompactMessages({
      previous,
      summaryText: "Did the thing.",
      keepTail: 4,
    })
    expect(next.length).toBe(5) // checkpoint + 4
    const first = next[0]
    expect(first.role).toBe("user")
    const text =
      typeof first.content === "string"
        ? first.content
        : first.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    expect(text).toContain(COMPACTION_USER_MARKER)
    expect(text).toContain("Did the thing.")
  })

  it("does not start tail mid unpaired tool_use", () => {
    const previous: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
      { role: "user", content: "later" },
    ]
    const next = buildLocalCompactMessages({ previous, keepTail: 2 })
    // Leading unpaired tool_use assistant is dropped; user remains after checkpoint.
    expect(next.some((m) => m.role === "assistant")).toBe(false)
    expect(next.some((m) => m.role === "user" && JSON.stringify(m.content).includes("later"))).toBe(
      true,
    )
  })

  it("drops a trailing tool_use with no matching tool_result in the tail", () => {
    const previous: Message[] = [
      { role: "user", content: "u0" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "out1" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } }],
      },
    ]
    const next = buildLocalCompactMessages({ previous, keepTail: 1 })
    // Tail is just the dangling call, so only the checkpoint remains.
    expect(next.length).toBe(1)
    expect(next.some((m) => m.role === "assistant")).toBe(false)
  })

  it("shifts a leading orphan tool_result whose call was cut off", () => {
    const previous: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t0", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t0", content: "out0" }],
      },
      { role: "user", content: "later" },
    ]
    const next = buildLocalCompactMessages({ previous, keepTail: 2 })
    // Orphan tool_result is shifted; plain user text remains after checkpoint.
    expect(next.some((m) => JSON.stringify(m.content).includes("tool_result"))).toBe(false)
    expect(next.some((m) => m.role === "user" && JSON.stringify(m.content).includes("later"))).toBe(
      true,
    )
  })

  it("keeps intact tool_use/tool_result pairs in the tail", () => {
    const previous: Message[] = [
      { role: "user", content: "u0" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "out1" }],
      },
      { role: "user", content: "later" },
    ]
    const next = buildLocalCompactMessages({ previous, keepTail: 3 })
    expect(next.some((m) => JSON.stringify(m.content).includes('"id":"t1"'))).toBe(true)
    expect(next.some((m) => JSON.stringify(m.content).includes('"tool_use_id":"t1"'))).toBe(true)
    expect(next.some((m) => m.role === "user" && JSON.stringify(m.content).includes("later"))).toBe(
      true,
    )
  })
})

describe("extractPendingUserText", () => {
  it("returns trailing plain user text", () => {
    const messages: Message[] = [
      { role: "assistant", content: "ok" },
      { role: "user", content: "retry me" },
    ]
    expect(extractPendingUserText(messages)).toBe("retry me")
  })

  it("returns null for tool_result tails", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }],
      },
    ]
    expect(extractPendingUserText(messages)).toBeNull()
  })
})

describe("flattenHistoryForSummary", () => {
  it("includes roles and respects maxChars", () => {
    const messages: Message[] = [
      { role: "user", content: "hello world" },
      { role: "assistant", content: "hi" },
    ]
    const flat = flattenHistoryForSummary(messages, 10_000)
    expect(flat).toContain("USER:")
    expect(flat).toContain("hello world")
    const tiny = flattenHistoryForSummary(messages, 20)
    expect(tiny.length).toBeLessThanOrEqual(40)
  })
})

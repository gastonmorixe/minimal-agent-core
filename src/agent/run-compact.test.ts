/**
 * Integration-ish unit tests for runCompact (local path; no network).
 */
import { describe, expect, it } from "bun:test"

import type { Message } from "../llm/messages.ts"

import { COMPACTION_USER_MARKER } from "./context-compact.ts"
import { runCompact } from "./run-compact.ts"

describe("runCompact local path", () => {
  it("rewrites history in place with a local checkpoint when remote is forced off", async () => {
    const messages: Message[] = []
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `u${i}` })
      messages.push({ role: "assistant", content: `a${i}` })
    }
    const before = messages.length
    const notes: string[] = []
    const stats = await runCompact({
      messages,
      model: "does-not-matter",
      auth: { type: "api-key", token: "x" },
      reason: "manual",
      preferRemote: false,
      appendNote: (t) => notes.push(t),
    })
    expect(stats.kind).toBe("local")
    expect(stats.messagesBefore).toBe(before)
    expect(stats.messagesAfter).toBeLessThan(before)
    expect(messages.length).toBe(stats.messagesAfter)
    const firstText =
      typeof messages[0].content === "string"
        ? messages[0].content
        : messages[0].content.map((b) => (b.type === "text" ? b.text : "")).join("")
    expect(firstText).toContain(COMPACTION_USER_MARKER)
    expect(notes.some((n) => n.includes("compact: local"))).toBe(true)
  })

  it("is a no-op stats-wise on empty history", async () => {
    const messages: Message[] = []
    const stats = await runCompact({
      messages,
      model: "x",
      auth: { type: "api-key", token: "x" },
      reason: "auto",
      preferRemote: false,
    })
    expect(stats.messagesBefore).toBe(0)
    expect(stats.messagesAfter).toBe(0)
  })
})

/**
 * Durable compact fold: display keeps full history; model uses checkpoint.
 *
 * @module session/session-restore.compact.test
 */

import { describe, expect, it } from "bun:test"

import {
  foldRecordsForDisplay,
  foldRecordsForModel,
  loadSessionFromText,
} from "./session-restore.ts"
import type { SessionRecord } from "./session-store.ts"

function user(content: string, id?: string): SessionRecord {
  return { kind: "user", ts: "t", content, ...(id ? { id } : {}) }
}
function assistant(text: string): SessionRecord {
  return {
    kind: "assistant",
    ts: "t",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
  }
}

describe("foldRecordsForDisplay vs foldRecordsForModel", () => {
  const records: SessionRecord[] = [
    {
      kind: "meta",
      formatVersion: 1,
      sid: "s",
      createdAt: "t",
      model: "m",
      cwd: "/",
      systemHash: "x",
      toolsHash: "y",
      agentVersion: "0",
    },
    user("first", "u1"),
    assistant("reply1"),
    user("second", "u2"),
    assistant("reply2"),
    {
      kind: "compact",
      ts: "t",
      reason: "manual",
      compactKind: "remote",
      messagesBefore: 4,
      messagesAfter: 1,
      replacementMessages: [
        { role: "user", content: '<ma::context::compaction kind="remote" />\ncheckpoint' },
      ],
    },
    user("after compact", "u3"),
    assistant("reply3"),
  ]

  it("display fold keeps full pre-compact transcript", () => {
    const msgs = foldRecordsForDisplay(records)
    // meta+compact skipped; 3 user + 3 assistant
    expect(msgs).toHaveLength(6)
    expect(msgs[0]).toMatchObject({ role: "user", content: "first" })
    expect(msgs[4]).toMatchObject({ role: "user", content: "after compact" })
  })

  it("model fold (since-last-compact) starts at checkpoint", () => {
    const msgs = foldRecordsForModel(records)
    expect(msgs.length).toBeGreaterThanOrEqual(3)
    const first =
      typeof msgs[0].content === "string"
        ? msgs[0].content
        : msgs[0].content.map((b) => (b.type === "text" ? b.text : "")).join("")
    expect(first).toContain("checkpoint")
    // pre-compact "first"/"second" must not reappear as separate turns
    const texts = msgs.map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
    )
    expect(texts.some((t) => t === "first")).toBe(false)
    expect(texts.some((t) => t === "after compact")).toBe(true)
  })

  it("model fold policy full ignores compact", () => {
    const msgs = foldRecordsForModel(records, { mode: "full" })
    expect(msgs).toHaveLength(6)
    expect(msgs[0]).toMatchObject({ content: "first" })
  })

  it("loadSessionFromText uses model fold by default", () => {
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n"
    const loaded = loadSessionFromText(text)
    const first =
      typeof loaded.messages[0].content === "string"
        ? loaded.messages[0].content
        : loaded.messages[0].content.map((b) => (b.type === "text" ? b.text : "")).join("")
    // repairMessages may merge checkpoint + following user into one message
    // (roles must alternate). Checkpoint text must still be present.
    expect(first).toContain("checkpoint")
    // Full records + displayMessages for UI
    expect(loaded.records.some((r) => r.kind === "compact")).toBe(true)
    expect(loaded.displayMessages.length).toBe(6)
    expect(foldRecordsForDisplay(loaded.records).length).toBe(6)
  })

  it("repairMessages keeps compact checkpoint when merging consecutive users", () => {
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n"
    const loaded = loadSessionFromText(text)
    const joined = loaded.messages
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"),
      )
      .join("\n")
    expect(joined).toContain("checkpoint")
    expect(joined).toContain("after compact")
    expect(joined).not.toContain("first")
  })
})

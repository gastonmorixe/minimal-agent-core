/**
 * The session fold after a target switch: the model fold drops the thinking
 * that the live session discarded, the display fold keeps it, and the newest
 * record gives the target of a resume.
 *
 * @module session/session-restore.target-switch.test
 */

import { describe, expect, it } from "bun:test"

import type { ContentBlock, Message } from "../llm/messages.ts"

import {
  foldRecordsForDisplay,
  foldRecordsForModel,
  lastTargetSwitch,
  loadSessionFromText,
} from "./session-restore.ts"
import type { SessionRecord } from "./session-store.ts"

const ts = "2026-11-17T00:00:00.000Z"
const thinking: ContentBlock = { type: "thinking", thinking: "", signature: "sig-a" }
const redacted: ContentBlock = { type: "redacted_thinking", data: "encrypted" }
const answer = (t: string): ContentBlock => ({ type: "text", text: t })

const user = (t: string, id: string): SessionRecord => ({ kind: "user", ts, id, content: t })
const assistant = (content: ContentBlock[]): SessionRecord => ({
  kind: "assistant",
  ts,
  content,
  stopReason: "end_turn",
})
const switched = (model: string, discardedThinking: boolean): SessionRecord => ({
  kind: "target_switch",
  ts,
  providerId: "p2",
  credentialName: "second",
  model,
  discardedThinking,
})

const types = (
  records: SessionRecord[],
  fold: (records: SessionRecord[]) => Message[],
): string[][] =>
  fold(records).map((m) =>
    typeof m.content === "string" ? ["string"] : m.content.map((b) => b.type),
  )

describe("fold after a target switch", () => {
  const records: SessionRecord[] = [
    user("one", "u1"),
    assistant([thinking, answer("first")]),
    switched("model-x", true),
    user("two", "u2"),
    assistant([redacted, answer("second")]),
  ]

  it("the model fold drops thinking before the switch and keeps it after", () => {
    expect(types(records, foldRecordsForModel)).toEqual([
      ["string"],
      ["text"],
      ["string"],
      ["redacted_thinking", "text"],
    ])
  })

  it("the display fold keeps all thinking", () => {
    expect(types(records, foldRecordsForDisplay)).toEqual([
      ["string"],
      ["thinking", "text"],
      ["string"],
      ["redacted_thinking", "text"],
    ])
  })

  it("the last switch that discarded thinking sets the limit", () => {
    const more = [...records, switched("model-y", true)]
    expect(types(more, foldRecordsForModel)[3]).toEqual(["text"])
    // A switch that did not discard (an automatic adoption) moves no limit.
    const kept = [...records, switched("model-y", false)]
    expect(types(kept, foldRecordsForModel)[3]).toEqual(["redacted_thinking", "text"])
  })

  it("an assistant record that had only thinking gives no message, and the load joins the users", () => {
    const only: SessionRecord[] = [
      user("one", "u1"),
      assistant([thinking]),
      user("continue", "u2"),
      assistant([answer("done")]),
      switched("model-x", true),
    ]
    const text = only.map((r) => JSON.stringify(r)).join("\n")
    const loaded = loadSessionFromText(text)
    expect(loaded.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(JSON.stringify(loaded.messages)).not.toContain("sig-a")
    // The display copy still has it.
    expect(JSON.stringify(loaded.displayMessages)).toContain("sig-a")
  })

  it("does not change the stored records", () => {
    const before = JSON.stringify(records)
    foldRecordsForModel(records)
    expect(JSON.stringify(records)).toBe(before)
  })
})

describe("lastTargetSwitch", () => {
  it("gives the newest record, or null", () => {
    expect(lastTargetSwitch([user("one", "u1")])).toBeNull()
    const found = lastTargetSwitch([
      switched("model-x", true),
      user("one", "u1"),
      switched("model-y", false),
    ])
    expect(found).toMatchObject({ model: "model-y", providerId: "p2", credentialName: "second" })
  })
})

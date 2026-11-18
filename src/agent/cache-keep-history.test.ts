/**
 * Keep mode (F2, `thinkingHistory: "keep"`) after the history changes shape:
 * tail compaction (M5), a target switch and a resume (L7). The kept thinking
 * must stay byte-identical to the original, or go away as a whole turn.
 *
 * @module agent/cache-keep-history.test
 */

import { describe, expect, it } from "bun:test"

import type { ContentBlock, Message } from "../llm/messages.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { foldRecordsForModel, loadSessionFromText } from "../session/session-restore.ts"
import type { SessionRecord } from "../session/session-store.ts"
import { COMPACT_TEST_TEXT } from "../test-utils/compact-test-text.ts"

import { withRollingCacheBreakpoint } from "./cache.ts"
import { runCompact } from "./run-compact.ts"

const think = (t: string): ContentBlock =>
  ({ type: "thinking", thinking: `reason ${t}`, signature: `sig-${t}` }) as ContentBlock
const toolUse = (id: string): ContentBlock =>
  ({ type: "tool_use", id, name: "Read", input: { p: id } }) as ContentBlock
const toolResult = (id: string): ContentBlock =>
  ({ type: "tool_result", tool_use_id: id, content: "ok" }) as ContentBlock

/** A tool loop with signed thinking in every assistant turn. */
function loop(n: number): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]
  for (let i = 0; i < n; i++) {
    msgs.push({ role: "assistant", content: [think(`t${i}`), toolUse(`u${i}`)] })
    msgs.push({ role: "user", content: [toolResult(`u${i}`)] })
  }
  return msgs
}

/** Every thinking block in `msgs`, as JSON text. */
function thinkingBytes(msgs: Message[]): string[] {
  const out: string[] = []
  for (const m of msgs) {
    if (typeof m.content === "string") continue
    for (const b of m.content) if (b.type === "thinking") out.push(JSON.stringify(b))
  }
  return out
}

/** Every assistant message whose content has a thinking block, as JSON text. */
function assistantTurnsWithThinking(msgs: Message[]): string[] {
  return msgs
    .filter((m) => m.role === "assistant" && thinkingBytes([m]).length > 0)
    .map((m) => JSON.stringify(m.content))
}

describe("keep mode + tail compaction (M5)", () => {
  it("kept thinking after runCompact('tail') is byte-identical or dropped as a whole turn", async () => {
    const original = loop(6)
    const originalTurns = new Set(assistantTurnsWithThinking(original))
    const originalThinking = new Set(thinkingBytes(original))
    const messages = structuredClone(original)
    await runCompact({
      text: COMPACT_TEST_TEXT,
      lifecycle: NOOP_LIFECYCLE,
      messages,
      model: "x",
      auth: { type: "api-key", token: "x" },
      reason: "manual",
      mode: "tail",
      keepTail: 5,
    })
    expect(messages.length).toBeLessThan(original.length)
    const req = withRollingCacheBreakpoint(messages, "5m", { keepThinking: true, anchor: true })
    // Each kept thinking block is a byte-identical copy of an original block.
    const kept = thinkingBytes(req)
    expect(kept.length).toBeGreaterThan(0)
    for (const b of kept) expect(originalThinking.has(b)).toBe(true)
    // Each assistant turn with thinking is a whole original turn (cache
    // markers removed), never a turn with only a part of its blocks.
    const stripMarkers = (m: Message): Message => ({
      ...m,
      content:
        typeof m.content === "string"
          ? m.content
          : m.content.map((b) => {
              const { cache_control: _c, ...rest } = b
              return rest as ContentBlock
            }),
    })
    for (const turn of assistantTurnsWithThinking(req.map(stripMarkers))) {
      expect(originalTurns.has(turn)).toBe(true)
    }
    // The first message is the checkpoint (user); the first kept assistant
    // turn has its tool_result after it, so tool pairs stay whole.
    expect(req[0].role).toBe("user")
  })
})

const ts = "2026-11-18T00:00:00.000Z"
const userRec = (t: string, id: string): SessionRecord => ({ kind: "user", ts, id, content: t })
const assistantRec = (content: ContentBlock[]): SessionRecord => ({
  kind: "assistant",
  ts,
  content,
  stopReason: "end_turn",
})
const text = (t: string): ContentBlock => ({ type: "text", text: t })

describe("keep mode after a target switch and a resume (L7)", () => {
  it("after a target switch: thinking before the switch is gone, thinking after is byte-identical", () => {
    const records: SessionRecord[] = [
      userRec("one", "u1"),
      assistantRec([think("a"), text("first")]),
      {
        kind: "target_switch",
        ts,
        providerId: "p2",
        credentialName: "second",
        model: "model-x",
        discardedThinking: true,
      },
      userRec("two", "u2"),
      assistantRec([think("b"), text("second")]),
      userRec("three", "u3"),
      assistantRec([think("c"), text("third")]),
      userRec("four", "u4"),
    ]
    const msgs = foldRecordsForModel(records)
    const req = withRollingCacheBreakpoint(msgs, "5m", { keepThinking: true, anchor: true })
    expect(thinkingBytes(req)).toEqual([JSON.stringify(think("b")), JSON.stringify(think("c"))])
    // The pre-switch turn keeps its text, with no thinking (no gap).
    expect(JSON.stringify(req[1].content)).toBe(JSON.stringify([text("first")]))
    // Append-only: the request of the next round has this request as a prefix.
    const next = withRollingCacheBreakpoint(
      [
        ...msgs,
        { role: "assistant", content: [think("d"), text("fourth")] },
        {
          role: "user",
          content: "five",
        },
      ],
      "5m",
      { keepThinking: true, anchor: true },
    )
    for (const i of [1, 3, 5]) expect(JSON.stringify(next[i])).toBe(JSON.stringify(req[i]))
  })

  it("after a resume: the keep-mode request is the same as the live one", () => {
    const records: SessionRecord[] = [
      userRec("one", "u1"),
      assistantRec([think("a"), text("first")]),
      userRec("two", "u2"),
      assistantRec([think("b"), text("second")]),
      userRec("three", "u3"),
    ]
    const loaded = loadSessionFromText(records.map((r) => JSON.stringify(r)).join("\n"))
    const live: Message[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: [think("a"), text("first")] },
      { role: "user", content: "two" },
      { role: "assistant", content: [think("b"), text("second")] },
      { role: "user", content: "three" },
    ]
    const opts = { keepThinking: true, anchor: true }
    const fromResume = withRollingCacheBreakpoint(loaded.messages, "5m", opts)
    const fromLive = withRollingCacheBreakpoint(live, "5m", opts)
    expect(thinkingBytes(fromResume)).toEqual(thinkingBytes(fromLive))
    expect(thinkingBytes(fromResume).length).toBe(2)
    const shape = (ms: Message[]) =>
      JSON.stringify(ms.map((m) => ({ role: m.role, content: m.content })))
    expect(shape(fromResume)).toBe(shape(fromLive))
  })
})

import { describe, expect, it } from "bun:test"

import type { ContentBlock, Message } from "../client/types.ts"

import { THINKING_OMITTED_TEXT, withRollingCacheBreakpoint } from "./cache.ts"

/** Every (message index, block index, ttl) that carries a marker. */
function markers(msgs: Message[]): Array<[number, number, string | undefined]> {
  const out: Array<[number, number, string | undefined]> = []
  msgs.forEach((m, i) => {
    if (typeof m.content === "string") return
    m.content.forEach((b, j) => {
      const cc = (b as { cache_control?: { ttl?: string } }).cache_control
      if (cc) out.push([i, j, cc.ttl])
    })
  })
  return out
}

const think = (t: string): ContentBlock =>
  ({ type: "thinking", thinking: t, signature: `sig-${t}` }) as ContentBlock
const text = (t: string): ContentBlock => ({ type: "text", text: t })
const toolUse = (id: string): ContentBlock =>
  ({ type: "tool_use", id, name: "Read", input: { p: id } }) as ContentBlock
const toolResult = (id: string): ContentBlock =>
  ({ type: "tool_result", tool_use_id: id, content: "ok" }) as ContentBlock

/** A tool loop: user prompt, then `n` (assistant think+tool_use, user tool_result) pairs. */
function loop(n: number): Message[] {
  const msgs: Message[] = [{ role: "user", content: [text("go")] }]
  for (let i = 0; i < n; i++) {
    msgs.push({ role: "assistant", content: [think(`t${i}`), toolUse(`u${i}`)] })
    msgs.push({ role: "user", content: [toolResult(`u${i}`)] })
  }
  return msgs
}

describe("withRollingCacheBreakpoint anchor (F1)", () => {
  it("the helper adds no anchor without the option (the send policy sets the default)", () => {
    expect(markers(withRollingCacheBreakpoint(loop(3)))).toEqual([[6, 0, "5m"]])
  })

  it("marks the last eligible block of the message before the latest assistant", () => {
    const out = withRollingCacheBreakpoint(loop(3), "5m", { anchor: true })
    // latest assistant = index 5, so the anchor goes on index 4 (previous tail).
    expect(markers(out)).toEqual([
      [4, 0, "5m"],
      [6, 0, "5m"],
    ])
  })

  it("uses the same ttl as the tail", () => {
    const out = withRollingCacheBreakpoint(loop(2), "1h", { anchor: true })
    expect(markers(out)).toEqual([
      [2, 0, "1h"],
      [4, 0, "1h"],
    ])
  })

  it("skips the anchor with fewer than 2 assistant messages", () => {
    expect(markers(withRollingCacheBreakpoint(loop(1), "5m", { anchor: true }))).toEqual([
      [2, 0, "5m"],
    ])
    expect(markers(withRollingCacheBreakpoint(loop(0), "5m", { anchor: true }))).toEqual([
      [0, 0, "5m"],
    ])
  })

  it("never puts the anchor on a thinking block", () => {
    // Message before the latest assistant ends in thinking (an assistant
    // prefill-like history): the anchor walks back to the text block.
    const msgs: Message[] = [
      { role: "user", content: [text("go")] },
      { role: "assistant", content: [text("a"), think("x")] },
      { role: "assistant", content: [text("b"), think("y")] },
      { role: "assistant", content: [text("c")] },
      { role: "user", content: [text("next")] },
    ]
    const out = withRollingCacheBreakpoint(msgs, "5m", { anchor: true, keepThinking: true })
    expect(markers(out)).toEqual([
      [2, 0, "5m"],
      [4, 0, "5m"],
    ])
  })

  it("skips the anchor when the target message is all thinking", () => {
    const msgs: Message[] = [
      { role: "user", content: [text("go")] },
      { role: "assistant", content: [toolUse("u0")] },
      { role: "assistant", content: [think("only")] },
      { role: "assistant", content: [text("c")] },
      { role: "user", content: [text("next")] },
    ]
    const out = withRollingCacheBreakpoint(msgs, "5m", { anchor: true, keepThinking: true })
    expect(markers(out)).toEqual([[4, 0, "5m"]])
  })

  it("never doubles the tail: a history that ends on an assistant turn", () => {
    // The anchor target is always before the latest assistant message, so it
    // can never be the tail block; the tail stays on the last message.
    const msgs: Message[] = [
      { role: "user", content: [text("go")] },
      { role: "assistant", content: [text("a")] },
      { role: "user", content: [text("q")] },
      { role: "assistant", content: [text("b")] },
    ]
    const out = withRollingCacheBreakpoint(msgs, "5m", { anchor: true })
    expect(markers(out)).toEqual([
      [2, 0, "5m"],
      [3, 0, "5m"],
    ])
  })

  it("skips a system-role target message (L6)", () => {
    const msgs = [
      { role: "user", content: [text("go")] },
      { role: "assistant", content: [toolUse("u0")] },
      { role: "system", content: [text("sys note")] },
      { role: "assistant", content: [toolUse("u1")] },
      { role: "user", content: [toolResult("u1")] },
    ] as unknown as Message[]
    const out = withRollingCacheBreakpoint(msgs, "5m", { anchor: true })
    expect(markers(out)).toEqual([[4, 0, "5m"]])
  })

  it("does not mutate the caller's history", () => {
    const msgs = loop(3)
    const before = JSON.stringify(msgs)
    withRollingCacheBreakpoint(msgs, "5m", { anchor: true })
    expect(JSON.stringify(msgs)).toBe(before)
  })

  it("turns a string-content target into one marked text block", () => {
    const msgs: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [toolUse("u0")] },
      { role: "user", content: "plain" },
      { role: "assistant", content: [toolUse("u1")] },
      { role: "user", content: [toolResult("u1")] },
    ]
    const out = withRollingCacheBreakpoint(msgs, "5m", { anchor: true })
    expect(out[2].content).toEqual([
      { type: "text", text: "plain", cache_control: { type: "ephemeral", ttl: "5m" } },
    ])
  })
})

describe("withRollingCacheBreakpoint keepThinking (F2)", () => {
  it("strip mode (default) drops older thinking, as before", () => {
    const out = withRollingCacheBreakpoint(loop(3))
    expect(out[1].content).toEqual([toolUse("u0")])
    expect(out[3].content).toEqual([toolUse("u1")])
    expect(out[5].content).toEqual([think("t2"), toolUse("u2")])
  })

  it("keep mode keeps the thinking of every assistant turn", () => {
    const out = withRollingCacheBreakpoint(loop(3), "5m", { keepThinking: true })
    expect(out[1].content).toEqual([think("t0"), toolUse("u0")])
    expect(out[3].content).toEqual([think("t1"), toolUse("u1")])
  })

  it("keep mode: older assistant messages are byte-identical across two consecutive builds", () => {
    const h1 = loop(3)
    const h2 = [
      ...h1,
      { role: "assistant", content: [think("t3"), toolUse("u3")] } as Message,
      { role: "user", content: [toolResult("u3")] } as Message,
    ]
    const r1 = withRollingCacheBreakpoint(h1, "5m", { keepThinking: true, anchor: true })
    const r2 = withRollingCacheBreakpoint(h2, "5m", { keepThinking: true, anchor: true })
    for (const i of [1, 3, 5]) {
      expect(JSON.stringify(r2[i])).toBe(JSON.stringify(r1[i]))
    }
    // The previous tail (r1[6]) is the new anchor (r2[6]): same bytes, same marker.
    expect(JSON.stringify(r2[6])).toBe(JSON.stringify(r1[6]))
  })

  it("strip mode: an all-thinking older turn gets one text block, no thinking gap (M4)", () => {
    const msgs: Message[] = [
      { role: "user", content: [text("go")] },
      { role: "assistant", content: [think("only")] },
      { role: "user", content: [text("more")] },
      { role: "assistant", content: [think("t1"), toolUse("u1")] },
      { role: "user", content: [toolResult("u1")] },
      { role: "assistant", content: [think("t2"), toolUse("u2")] },
      { role: "user", content: [toolResult("u2")] },
    ]
    const before = JSON.stringify(msgs)
    const out = withRollingCacheBreakpoint(msgs)
    expect(out[1].content).toEqual([{ type: "text", text: THINKING_OMITTED_TEXT }])
    expect(out[3].content).toEqual([toolUse("u1")])
    expect(out[5].content).toEqual([think("t2"), toolUse("u2")])
    // No thinking block before the latest assistant message.
    const older = out.slice(0, 5).flatMap((m) => (typeof m.content === "string" ? [] : m.content))
    expect(older.some((b) => b.type === "thinking")).toBe(false)
    expect(JSON.stringify(msgs)).toBe(before)
  })

  it("keep mode: an all-thinking older turn stays byte-identical (M4 is strip only)", () => {
    const msgs: Message[] = [
      { role: "user", content: [text("go")] },
      { role: "assistant", content: [think("only")] },
      { role: "user", content: [text("more")] },
      { role: "assistant", content: [think("t1"), toolUse("u1")] },
      { role: "user", content: [toolResult("u1")] },
    ]
    const out = withRollingCacheBreakpoint(msgs, "5m", { keepThinking: true })
    expect(out[1].content).toEqual([think("only")])
  })

  it("strip mode: the last-1 assistant turn changes between builds (today's cache break)", () => {
    const h1 = loop(2)
    const h2 = [
      ...h1,
      { role: "assistant", content: [think("t2"), toolUse("u2")] } as Message,
      { role: "user", content: [toolResult("u2")] } as Message,
    ]
    const r1 = withRollingCacheBreakpoint(h1)
    const r2 = withRollingCacheBreakpoint(h2)
    expect(JSON.stringify(r2[3])).not.toBe(JSON.stringify(r1[3]))
  })
})

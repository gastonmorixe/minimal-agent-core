import { describe, expect, it } from "bun:test"

import { withRollingCacheBreakpoint } from "./agent.ts"
import type { ContentBlock, Message } from "./client/types.ts"

describe("withRollingCacheBreakpoint", () => {
  const tail = (msgs: Message[]) => {
    const last = msgs[msgs.length - 1]
    if (typeof last.content === "string") return null
    return last.content[last.content.length - 1] as { cache_control?: unknown }
  }

  it("returns the input unchanged when there are no messages", () => {
    expect(withRollingCacheBreakpoint([])).toEqual([])
  })

  it("stamps the last block of the last message with a 5m ephemeral marker by default", () => {
    const out = withRollingCacheBreakpoint([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ])
    expect(tail(out)?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
  })

  it("honors an explicit ttl override (1h) on the rolling breakpoint", () => {
    const out = withRollingCacheBreakpoint(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      "1h",
    )
    expect(tail(out)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("strips prior message-level cache_control markers", () => {
    const out = withRollingCacheBreakpoint([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "old",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "done" }] },
    ])
    const firstBlock = (out[0].content as Array<{ cache_control?: unknown }>)[0]
    expect(firstBlock.cache_control).toBeUndefined()
    expect(tail(out)?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
  })

  it("normalizes a string-content tail into a one-block array before stamping", () => {
    const out = withRollingCacheBreakpoint([{ role: "user", content: "hello" }])
    const last = out[out.length - 1]
    expect(Array.isArray(last.content)).toBe(true)
    expect(tail(out)?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
  })

  it("does not mutate the caller's messages array", () => {
    const original: Message[] = [{ role: "user", content: [{ type: "text", text: "a" }] }]
    withRollingCacheBreakpoint(original)
    const block = original[0].content as Array<{ cache_control?: unknown }>
    expect(block[0].cache_control).toBeUndefined()
  })

  // Regression: 400 "`thinking` or `redacted_thinking` blocks in the latest
  // assistant message cannot be modified". When the conversation ends on an
  // assistant turn whose tail is a thinking block (assistant prefill, or a
  // forked/resumed long interleaved-thinking turn re-sent verbatim), the
  // rolling breakpoint must NOT land on the thinking block: adding
  // cache_control to it is a modification the API rejects.
  it("never stamps cache_control on a trailing thinking block of the last message", () => {
    const out = withRollingCacheBreakpoint([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "ponder A", signature: "sigA" },
          { type: "text", text: "partial answer" },
          { type: "thinking", thinking: "ponder B", signature: "sigB" },
        ],
      },
    ])
    const lastBlocks = out[out.length - 1].content as Array<{
      type: string
      cache_control?: unknown
    }>
    // The trailing thinking block stays untouched...
    expect(lastBlocks[2].type).toBe("thinking")
    expect(lastBlocks[2].cache_control).toBeUndefined()
    // ...and the breakpoint moves to the last NON-thinking block.
    expect(lastBlocks[1].type).toBe("text")
    expect(lastBlocks[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
    // The earlier thinking block is also left alone.
    expect(lastBlocks[0].cache_control).toBeUndefined()
  })

  it("sends the latest assistant message's thinking blocks byte-identical (text + signature)", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "step 1", signature: "AAA==" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          { type: "thinking", thinking: "step 2", signature: "BBB==" },
        ],
      },
    ]
    const out = withRollingCacheBreakpoint(messages)
    const sent = out[out.length - 1].content as Array<{
      type: string
      thinking?: string
      signature?: string
      cache_control?: unknown
    }>
    const thinking = sent.filter((b) => b.type === "thinking")
    // Both thinking blocks survive verbatim: same text, same signature, and
    // crucially NO cache_control was added or stripped onto them.
    expect(thinking).toEqual([
      { type: "thinking", thinking: "step 1", signature: "AAA==" },
      { type: "thinking", thinking: "step 2", signature: "BBB==" },
    ])
    // The breakpoint landed on the only non-thinking block (the tool_use).
    const toolUse = sent.find((b) => b.type === "tool_use") as { cache_control?: unknown }
    expect(toolUse.cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
  })

  it("skips the breakpoint entirely when the last message is all thinking", () => {
    const out = withRollingCacheBreakpoint([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "only thought A", signature: "s1" },
          { type: "thinking", thinking: "only thought B", signature: "s2" },
        ],
      },
    ])
    const lastBlocks = out[out.length - 1].content as Array<{ cache_control?: unknown }>
    // No block gets a breakpoint (a thinking-only tail is left untouched), so
    // the request stays API-valid even though the rolling cache skips a turn.
    expect(lastBlocks.every((b) => b.cache_control === undefined)).toBe(true)
  })

  // Regression: long interleaved-thinking conversations 400 with "`thinking`
  // or `redacted_thinking` blocks in the latest assistant message cannot be
  // modified" once several prior assistant turns' thinking accumulates (~200KB
  // of signatures). The API only needs the LATEST assistant turn's thinking,
  // so older turns' thinking must be stripped before sending. The latest
  // turn's thinking stays byte-identical; tool_use pairing is preserved.
  it("strips thinking from older assistant turns but keeps the latest turn's verbatim", () => {
    const out = withRollingCacheBreakpoint([
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning A", signature: "sigA" },
          { type: "text", text: "doing A" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "a" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ra" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning B", signature: "sigB" },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "b" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "rb" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "latest reasoning", signature: "sigZ" },
          { type: "tool_use", id: "t3", name: "Bash", input: { command: "c" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: "rc" }] },
    ])
    // Older assistant turns (indices 1, 3): thinking dropped, tool_use kept.
    for (const i of [1, 3]) {
      const blocks = out[i].content as Array<{ type: string }>
      expect(blocks.some((b) => b.type === "thinking")).toBe(false)
      expect(blocks.some((b) => b.type === "tool_use")).toBe(true)
    }
    // Latest assistant turn (index 5): thinking PRESERVED byte-identical.
    const latest = out[5].content as Array<{ type: string; thinking?: string; signature?: string }>
    expect(latest.find((b) => b.type === "thinking")).toEqual({
      type: "thinking",
      thinking: "latest reasoning",
      signature: "sigZ",
    })
  })

  it("also guards a literal redacted_thinking tail block", () => {
    const out = withRollingCacheBreakpoint([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "here" },
          // The wire type a restored/forked session can carry.
          { type: "redacted_thinking", data: "abc" } as unknown as ContentBlock,
        ],
      },
    ])
    const lastBlocks = out[out.length - 1].content as Array<{
      type: string
      cache_control?: unknown
    }>
    expect(lastBlocks[1].type).toBe("redacted_thinking")
    expect(lastBlocks[1].cache_control).toBeUndefined()
    expect(lastBlocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
  })
})

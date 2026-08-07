import { describe, expect, it } from "bun:test"

import type { ContentBlock, Message, ToolResultBlock } from "../llm/messages.ts"

import { appendUserTurn } from "./conversation-history.ts"

describe("appendUserTurn", () => {
  it("appends a fresh user message after an assistant turn", () => {
    const content: ContentBlock[] = [{ type: "text", text: "next" }]
    const messages: Message[] = [{ role: "assistant", content: [{ type: "text", text: "hello" }] }]

    appendUserTurn(messages, content)

    expect(messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ])
    expect(messages[1].content).toBe(content)
  })

  it("appends a fresh user message to empty history", () => {
    const content: ContentBlock[] = [{ type: "text", text: "first" }]
    const messages: Message[] = []

    appendUserTurn(messages, content)

    expect(messages).toEqual([{ role: "user", content }])
    expect(messages[0].content).toBe(content)
  })

  it("coalesces with a trailing tool-result user message", () => {
    const toolResult: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "ok",
      is_error: false,
    }
    const input = { type: "text", text: "draft" } as const
    const messages: Message[] = [{ role: "user", content: [toolResult] }]

    appendUserTurn(messages, [input])

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toEqual([toolResult, input])
  })

  it("keeps tool results first when a trailing user message is mixed", () => {
    const firstText = { type: "text", text: "before" } as const
    const firstToolResult: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "one",
    }
    const secondText = { type: "text", text: "between" } as const
    const secondToolResult: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu_2",
      content: "two",
    }
    const input = { type: "text", text: "after" } as const
    const messages: Message[] = [
      {
        role: "user",
        content: [firstText, firstToolResult, secondText, secondToolResult],
      },
    ]

    appendUserTurn(messages, [input])

    expect(messages[0].content).toEqual([
      firstToolResult,
      secondToolResult,
      firstText,
      secondText,
      input,
    ])
  })

  it("preserves empty content structurally", () => {
    const messages: Message[] = []

    appendUserTurn(messages, [])

    expect(JSON.stringify(messages)).toBe('[{"role":"user","content":[]}]')
  })

  it("does not clone or rewrite input block objects", () => {
    const existing = { type: "text", text: "existing" } as const
    const input = { type: "text", text: "input" } as const
    const messages: Message[] = [{ role: "user", content: [existing] }]

    appendUserTurn(messages, [input])

    const merged = messages[0].content as ContentBlock[]
    expect(merged[0]).toBe(existing)
    expect(merged[1]).toBe(input)
  })
})

import { describe, expect, it } from "bun:test"

import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "./client.ts"
import { repairTrailingTurn } from "./session-restore.ts"

// Split out of `session-restore.test.ts` (which exceeded the 810-line lint cap
// when these empty-text-block regression tests landed). Same module under test
// (`repairMessages`/`repairTrailingTurn`); this file owns only the empty /
// whitespace-only text-block stripping that keeps a cross-provider resume from
// 400ing with "messages: text content blocks must be non-empty".

describe("repairMessages — empty text block stripping", () => {
  // Cross-provider resume regression (the motivating bug): a session created
  // under an OpenAI-compatible provider (Ollama / OpenAI) persists assistant
  // turns shaped `[text, tool_use, text:""]` — the trailing empty text block
  // is manufactured by the bridge's deferred text_stop. Those providers accept
  // it; resuming the SAME session under Anthropic 400s with
  // "messages: text content blocks must be non-empty". repairMessages must
  // strip the empties so the resend is clean.
  it("strips a trailing empty text block in an assistant tool_use turn", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running it." },
          { type: "tool_use", id: "tu_1", name: "Bash", input: {} } as ToolUseBlock,
          { type: "text", text: "" },
        ],
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
    const asst = repaired[1].content as ContentBlock[]
    expect(asst.map((b) => b.type)).toEqual(["text", "tool_use"])
    expect(asst.some((b) => b.type === "text" && (b as { text: string }).text === "")).toBe(false)
  })

  it("strips whitespace-only text blocks too", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "   \n  " },
          { type: "text", text: "real answer" },
        ],
      },
    ]
    const repaired = repairTrailingTurn(messages)
    const asst = repaired[1].content as ContentBlock[]
    expect(asst).toEqual([{ type: "text", text: "real answer" }])
  })

  it("strips an empty text block from a user message, keeping the rest", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "actual prompt" },
        ],
      },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired[0].content).toEqual([{ type: "text", text: "actual prompt" }])
  })

  it("drops an assistant message that is ONLY an empty text block", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
    ]
    const repaired = repairTrailingTurn(messages)
    // The all-empty assistant is dropped; the [user, user] adjacency that
    // exposes is then collapsed by the consecutive-user pass, leaving one user.
    expect(repaired).toHaveLength(1)
    expect(repaired[0].role).toBe("user")
    expect(repaired[0].content).toEqual([{ type: "text", text: "b" }])
  })

  it("preserves non-empty text and is idempotent", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "keep me" },
          { type: "tool_use", id: "tu_z", name: "Read", input: {} } as ToolUseBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_z",
            content: "data",
            is_error: false,
          } as ToolResultBlock,
        ],
      },
    ]
    const once = repairTrailingTurn(messages)
    const twice = repairTrailingTurn(once)
    expect(once).toEqual(twice)
    expect((once[1].content as ContentBlock[]).map((b) => b.type)).toEqual(["text", "tool_use"])
  })
})

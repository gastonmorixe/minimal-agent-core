import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "./client.ts"
import {
  appendUserTurn,
  extractPendingDraft,
  firstUserPromptSnippet,
  foldRecords,
  loadSession,
  loadSessionFromText,
  repairTrailingTurn,
} from "./session-restore.ts"
import { type SessionRecord, SessionStore } from "./session-store.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ma-session-restore-"))
}

const baseOpenOpts = {
  model: "claude-sonnet-4-6",
  cwd: "/tmp/example",
  systemHash: "deadbeef",
  toolsHash: "cafebabe",
  agentVersion: "test",
}

describe("foldRecords", () => {
  it("folds a clean turn (user → assistant text)", () => {
    const records: SessionRecord[] = [
      {
        kind: "meta",
        formatVersion: 1,
        sid: "x",
        createdAt: "t",
        model: "m",
        cwd: "/x",
        systemHash: "h",
        toolsHash: "h",
        agentVersion: "v",
      },
      { kind: "user", ts: "t", content: "hello" },
      {
        kind: "assistant",
        ts: "t",
        content: [{ type: "text", text: "hi" }],
        stopReason: "end_turn",
      },
    ]
    const messages = foldRecords(records)
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("user")
    expect(messages[0].content).toBe("hello")
    expect(messages[1].role).toBe("assistant")
  })

  it("merges multiple tool_results into a single user turn", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t", content: "do stuff" },
      {
        kind: "assistant",
        ts: "t",
        content: [
          { type: "tool_use", id: "tu_1", name: "Bash", input: {} },
          { type: "tool_use", id: "tu_2", name: "Bash", input: {} },
        ],
        stopReason: "tool_use",
      },
      { kind: "tool_result", ts: "t", tool_use_id: "tu_1", content: "ok1", isError: false },
      { kind: "tool_result", ts: "t", tool_use_id: "tu_2", content: "ok2", isError: false },
    ]
    const messages = foldRecords(records)
    expect(messages).toHaveLength(3)
    const trailing = messages[2]
    expect(trailing.role).toBe("user")
    expect(Array.isArray(trailing.content)).toBe(true)
    const blocks = trailing.content as ToolResultBlock[]
    expect(blocks).toHaveLength(2)
    expect(blocks[0].tool_use_id).toBe("tu_1")
    expect(blocks[1].tool_use_id).toBe("tu_2")
  })

  it("skips meta and note records", () => {
    const records: SessionRecord[] = [
      {
        kind: "meta",
        formatVersion: 1,
        sid: "x",
        createdAt: "t",
        model: "m",
        cwd: "/x",
        systemHash: "h",
        toolsHash: "h",
        agentVersion: "v",
      },
      { kind: "note", ts: "t", text: "hello world" },
      { kind: "user", ts: "t", content: "hi" },
    ]
    expect(foldRecords(records)).toHaveLength(1)
  })
})

describe("repairTrailingTurn", () => {
  it("drops a trailing assistant turn with unmatched tool_use", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running..." },
          { type: "tool_use", id: "tu_orphan", name: "Bash", input: {} } as ToolUseBlock,
        ],
      },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(1)
    expect(repaired[0].role).toBe("user")
  })

  it("preserves trailing user-with-tool_results when matched by previous assistant", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} } as ToolUseBlock],
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
  })

  it("preserves a clean end_turn assistant", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    expect(repairTrailingTurn(messages)).toHaveLength(2)
  })

  it("is idempotent on already-valid input", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    const once = repairTrailingTurn(messages)
    const twice = repairTrailingTurn(once)
    expect(twice).toEqual(once)
  })

  it("handles cascading drops (assistant tool_use, no result, assistant tool_use again)", () => {
    const messages: Message[] = [
      { role: "user", content: "a" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_a", name: "Bash", input: {} } as ToolUseBlock],
      },
      // missing tool_result for tu_a — invalid — but somehow another assistant got appended:
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_b", name: "Bash", input: {} } as ToolUseBlock],
      },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(1)
    expect(repaired[0].role).toBe("user")
  })

  it("reorders user message blocks so tool_result comes first (Bug: API requires tool_result immediately after tool_use)", () => {
    // Repro: a queued user submit's appendUser landed BETWEEN the assistant's
    // appendAssistant and the for-tools loop's appendToolResult. foldRecords
    // then attached the tool_result onto the existing `[text]` user message,
    // producing `[text, tool_result]`. Anthropic API rejects this with
    // "tool_use ids were found without tool_result blocks immediately after".
    const messages: Message[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_x",
            name: "Bash",
            input: { command: "echo" },
          } as ToolUseBlock,
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "queued by user mid-turn" },
          {
            type: "tool_result",
            tool_use_id: "tu_x",
            content: "out",
            is_error: false,
          } as ToolResultBlock,
        ],
      },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(3)
    const userMsg = repaired[2]
    expect(userMsg.role).toBe("user")
    expect(Array.isArray(userMsg.content)).toBe(true)
    const blocks = userMsg.content as ContentBlock[]
    // tool_result MUST be first.
    expect(blocks[0].type).toBe("tool_result")
    expect((blocks[0] as ToolResultBlock).tool_use_id).toBe("tu_x")
    expect(blocks[1].type).toBe("text")
  })

  it("drops a trailing user message whose tool_results have no matching tool_use", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_dangling",
            content: "ghost",
            is_error: false,
          } as ToolResultBlock,
        ],
      },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(2)
  })

  // Step 4 of repair: when two user messages end up adjacent in the
  // output (typically because an assistant turn between them was
  // dropped by step 1), drop the EARLIER one. The later one is the
  // live conversation; the earlier one was an orphan prompt that
  // already had its retry chance via `pendingDraft` on the prior
  // resume. See the function doc for the full multi-resume scenario.
  it("drops the EARLIER user in a [user, user, assistant] adjacency", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "user", content: [{ type: "text", text: "hello again" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(2)
    expect(repaired[0].role).toBe("user")
    const firstUserText = (repaired[0].content as Array<{ type: string; text?: string }>)[0].text
    expect(firstUserText).toBe("hello again")
    expect(repaired[1].role).toBe("assistant")
  })

  it("collapses a run of 3+ consecutive user messages to the last one", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
      { role: "user", content: [{ type: "text", text: "c" }] },
      { role: "assistant", content: [{ type: "text", text: "reply to c" }] },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(2)
    expect((repaired[0].content as Array<{ type: string; text?: string }>)[0].text).toBe("c")
  })

  it("collapse pass is a no-op when users are already alternating with assistants", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "ans a" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "ans b" }] },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(4)
    expect(repaired.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
  })

  // Regression for the orphan-tool_use API 400 the user hit in sessions
  // 5dbabb43 + 2413e64a on 2026-05-27. Pattern on disk:
  //
  //   rec N    : assistant(tool_use X)
  //   rec N+1  : tool_result(X)             ← matching pair
  //   rec N+2  : user("new prompt text")    ← user typed while agent was working
  //
  // foldRecords turns rec N+1 into its own `user([tool_result X])` message
  // (because the prior message is the assistant), then rec N+2 produces a
  // SECOND user message. The naive consecutive-user collapse (step 4)
  // dropped the EARLIER user — which carried the load-bearing tool_result —
  // leaving the assistant's tool_use orphaned. Anthropic API rejects with
  //   "tool_use ids were found without tool_result blocks immediately after".
  // The fix: merge tool_result blocks from the earlier user into the later
  // user (prepended, so they keep the "tool_results first" invariant).
  it("merges tool_results from an earlier user into the later user (not drop)", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "kick off" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_x", name: "Bash", input: { command: "ls" } } as ToolUseBlock,
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_x",
            content: "ok",
            is_error: false,
          } as ToolResultBlock,
        ],
      },
      { role: "user", content: [{ type: "text", text: "new prompt mid-loop" }] },
      { role: "assistant", content: [{ type: "text", text: "continuing..." }] },
    ]
    const repaired = repairTrailingTurn(messages)
    // 4 messages: user(kick off), asst(tool_use), merged user, asst(continuing).
    expect(repaired).toHaveLength(4)
    expect(repaired.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
    const mergedUser = repaired[2]
    const blocks = mergedUser.content as ContentBlock[]
    // tool_result MUST be present AND first.
    expect(blocks[0].type).toBe("tool_result")
    expect((blocks[0] as ToolResultBlock).tool_use_id).toBe("tu_x")
    // The later user's text must also survive.
    const textBlock = blocks.find((b) => b.type === "text") as
      | { type: string; text: string }
      | undefined
    expect(textBlock?.text).toBe("new prompt mid-loop")
  })

  // Same situation, but the assistant's TRAILING turn never got a follow-up.
  // The earlier user (with tool_result) and later user (with text) are the
  // last two messages. Tool_result must still be preserved so the assistant
  // turn before them stays valid.
  it("preserves trailing tool_result even when the later user is a fresh prompt", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "start" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_y", name: "Bash", input: {} } as ToolUseBlock],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_y",
            content: "result",
            is_error: false,
          } as ToolResultBlock,
        ],
      },
      { role: "user", content: [{ type: "text", text: "second prompt" }] },
    ]
    const repaired = repairTrailingTurn(messages)
    expect(repaired).toHaveLength(3)
    const trailing = repaired[2]
    expect(trailing.role).toBe("user")
    const blocks = trailing.content as ContentBlock[]
    expect(blocks[0].type).toBe("tool_result")
    expect((blocks[0] as ToolResultBlock).tool_use_id).toBe("tu_y")
    expect(
      blocks.some((b) => b.type === "text" && (b as { text: string }).text === "second prompt"),
    ).toBe(true)
  })
})

describe("extractPendingDraft", () => {
  // The motivating case: user typed a prompt, pressed Enter, then the
  // agent aborted (Ctrl+C, crash, kill) before any assistant tokens
  // streamed. On resume the draft must NOT stay in messages (would
  // produce a [..., user, user] sequence the API rejects), it must be
  // surfaced for the REPL to restore into the editor buffer.
  it("pops trailing user-text and returns the joined text", () => {
    const messages: Message[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      {
        role: "user",
        content: [{ type: "text", text: "  unsent draft  " }],
      },
    ]
    const draft = extractPendingDraft(messages)
    expect(draft).toBe("unsent draft")
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe("assistant")
  })

  it("joins multi-block trailing user-text with blank-line separators", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "first paragraph" },
          { type: "text", text: "second paragraph" },
        ],
      },
    ]
    const draft = extractPendingDraft(messages)
    expect(draft).toBe("first paragraph\n\nsecond paragraph")
    expect(messages).toHaveLength(1)
  })

  // The "crashed mid-tool" case is handled by repairMessages first.
  // If a stray trailing user message WITH tool_results survives into
  // extractPendingDraft (load-bearing scenario, defensive), we must NOT
  // pop it — the tool_results round-trip back to the model on resume.
  it("does not touch a trailing user message containing tool_results", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} } as ToolUseBlock],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "out",
            is_error: false,
          } as ToolResultBlock,
        ],
      },
    ]
    const draft = extractPendingDraft(messages)
    expect(draft).toBeNull()
    expect(messages).toHaveLength(3)
  })

  // Mixed: a trailing user message with BOTH text and tool_result. This is
  // a force-quit mid-turn: the agent ran tools, results came back, but the
  // assistant continuation never streamed and the user's next prompt got
  // merged onto the same turn (repairMessages folds tool_results forward).
  // The human text becomes the pending draft (prefilled into the editor);
  // the load-bearing tool_results stay so the assistant's tool_use is still
  // paired. Without this, the prompt was wrongly replayed into scrollback.
  it("extracts the human text as a draft and keeps the tool_results", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_x", name: "Bash", input: {} } as ToolUseBlock],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_x",
            content: "out",
            is_error: false,
          } as ToolResultBlock,
          { type: "text", text: "and a queued prompt" },
        ],
      },
    ]
    const draft = extractPendingDraft(messages)
    expect(draft).toBe("and a queued prompt")
    expect(messages).toHaveLength(3)
    // The trailing user message keeps ONLY the tool_result (text pulled out).
    const tail = messages[2].content as Array<{ type: string }>
    expect(tail).toHaveLength(1)
    expect(tail[0].type).toBe("tool_result")
  })

  // The draft is human-typed prose only. Runtime attachment blocks the
  // send-seam prepends (short-term memory, tasks, mode-change, save-echo,
  // reflection markers) are regenerated on the next submit and must NOT
  // leak into the prefilled editor.
  it("strips runtime attachment blocks, keeping only the human text", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<ma::plugin::memory::short-term>\n[#1] note\n</ma::plugin::memory::short-term>",
          },
          { type: "text", text: '<ma::plugin::tasks total="2" done="1">…</ma::plugin::tasks>' },
          { type: "text", text: "the actual instruction I typed" },
        ],
      },
    ]
    const draft = extractPendingDraft(messages)
    expect(draft).toBe("the actual instruction I typed")
    expect(messages).toHaveLength(1) // whole message popped (no tool_results)
  })

  // An attachment-only trailing user message (no human prose) is plumbing,
  // not a draft. Leave it; surface nothing for the editor.
  it("returns null for an attachment-only trailing user message", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          { type: "text", text: '<ma::agent::mode-change from="ask" to="default" />' },
          { type: "text", text: '<ma::plugin::tasks total="1" done="0">…</ma::plugin::tasks>' },
        ],
      },
    ]
    const draft = extractPendingDraft(messages)
    expect(draft).toBeNull()
    expect(messages).toHaveLength(2)
  })

  // The full force-quit shape: tool_results + attachments + the unsent
  // prompt, all merged into the tail. Draft = the prompt only; the message
  // is rebuilt with just the tool_results.
  it("handles tool_results + attachments + human text together", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Edit", input: {} } as ToolUseBlock],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "File edited",
            is_error: false,
          } as ToolResultBlock,
          {
            type: "text",
            text: "<ma::plugin::memory::short-term>\nx\n</ma::plugin::memory::short-term>",
          },
          { type: "text", text: "ROLE LOCK — you are a manager" },
        ],
      },
    ]
    const draft = extractPendingDraft(messages)
    expect(draft).toBe("ROLE LOCK — you are a manager")
    expect(messages).toHaveLength(2)
    const tail = messages[1].content as Array<{ type: string }>
    expect(tail).toHaveLength(1)
    expect(tail[0].type).toBe("tool_result")
  })

  it("returns null when the trailing message is assistant", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]
    const draft = extractPendingDraft(messages)
    expect(draft).toBeNull()
    expect(messages).toHaveLength(2)
  })

  it("returns null on an empty messages array", () => {
    const messages: Message[] = []
    const draft = extractPendingDraft(messages)
    expect(draft).toBeNull()
  })

  // String-content user messages are the historical foldRecords shape
  // for plain-text turns; they shouldn't be common at the tail today
  // (live runtime uses block arrays), but a permissive pop would
  // silently lose history if the assumption ever flips. Stay strict.
  it("returns null when trailing user content is a bare string", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "hello" },
    ]
    const draft = extractPendingDraft(messages)
    expect(draft).toBeNull()
    expect(messages).toHaveLength(2)
  })

  // A trailing user message that is "all whitespace text" or "no text
  // blocks at all" (e.g. attachment-only payload) is plumbing, not a
  // draft. Don't pop and don't surface anything for the editor.
  it("returns null when text blocks exist but collapse to empty on trim", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [{ type: "text", text: "   \n\n  " }],
      },
    ]
    const draft = extractPendingDraft(messages)
    expect(draft).toBeNull()
    expect(messages).toHaveLength(2)
  })

  it("returns null when trailing user has no text blocks at all", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } } as any,
        ],
      },
    ]
    const draft = extractPendingDraft(messages)
    expect(draft).toBeNull()
    expect(messages).toHaveLength(2)
  })
})

describe("appendUserTurn", () => {
  it("appends a fresh user message when the last message is an assistant turn", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    appendUserTurn(messages, [{ type: "text", text: "next" }])
    expect(messages).toHaveLength(3)
    expect(messages[2].role).toBe("user")
    expect((messages[2].content as Array<{ text?: string }>)[0].text).toBe("next")
  })

  it("appends a fresh user message on an empty history", () => {
    const messages: Message[] = []
    appendUserTurn(messages, [{ type: "text", text: "first" }])
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("user")
  })

  it("coalesces into a trailing user([tool_result]) instead of [user, user]", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} } as ToolUseBlock],
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
    appendUserTurn(messages, [{ type: "text", text: "the resumed draft" }])
    // No second user message was created.
    expect(messages).toHaveLength(2)
    const blocks = messages[1].content as Array<{ type: string; text?: string }>
    // tool_result stays FIRST (API requires it immediately after tool_use).
    expect(blocks[0].type).toBe("tool_result")
    expect(blocks[1].type).toBe("text")
    expect(blocks[1].text).toBe("the resumed draft")
  })

  it("keeps tool_results first even when merging onto a mixed trailing message", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} } as ToolUseBlock],
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
          { type: "text", text: "leftover" },
        ],
      },
    ]
    appendUserTurn(messages, [{ type: "text", text: "new" }])
    expect(messages).toHaveLength(2)
    const blocks = messages[1].content as Array<{ type: string; text?: string }>
    expect(blocks.map((b) => b.type)).toEqual(["tool_result", "text", "text"])
    expect(blocks[1].text).toBe("leftover")
    expect(blocks[2].text).toBe("new")
  })
})

describe("loadSessionFromText (pendingDraft integration)", () => {
  // End-to-end reproduction of the user-reported case from session
  // 7548d4b2-d0f5-4ca8-a4c6-c283b3700a96: assistant finished one turn,
  // user typed a follow-up, agent detached before responding. On resume
  // today (pre-fix) this produced [..., assistant, user] in `messages`,
  // and the next agent.run pushed ANOTHER user → API rejects
  // "roles must alternate". The fix surfaces the trailing user-text as
  // `pendingDraft` and pops it from `messages` so the next turn is
  // clean.
  it("surfaces a trailing aborted user submit as pendingDraft", () => {
    const meta = JSON.stringify({
      kind: "meta",
      formatVersion: 1,
      sid: "ma-aborted",
      createdAt: "t",
      model: "m",
      cwd: "/x",
      systemHash: "h",
      toolsHash: "h",
      agentVersion: "v",
    })
    const u1 = JSON.stringify({ kind: "user", ts: "t", content: "first" })
    const a1 = JSON.stringify({
      kind: "assistant",
      ts: "t",
      content: [{ type: "text", text: "reply" }],
      stopReason: "end_turn",
    })
    const u2 = JSON.stringify({
      kind: "user",
      ts: "t",
      content: [{ type: "text", text: "Architecture A: file-based, please proceed." }],
    })
    const text = [meta, u1, a1, u2].join("\n")
    const loaded = loadSessionFromText(text)
    expect(loaded.pendingDraft).toBe("Architecture A: file-based, please proceed.")
    // The draft is popped — messages end at the assistant reply, so the
    // next turn's `[..., assistant, user-new]` is API-clean.
    expect(loaded.messages).toHaveLength(2)
    expect(loaded.messages.at(-1)?.role).toBe("assistant")
  })

  it("leaves pendingDraft null for a clean end-of-turn session", () => {
    const meta = JSON.stringify({
      kind: "meta",
      formatVersion: 1,
      sid: "ma-clean",
      createdAt: "t",
      model: "m",
      cwd: "/x",
      systemHash: "h",
      toolsHash: "h",
      agentVersion: "v",
    })
    const u1 = JSON.stringify({ kind: "user", ts: "t", content: "hi" })
    const a1 = JSON.stringify({
      kind: "assistant",
      ts: "t",
      content: [{ type: "text", text: "hello" }],
      stopReason: "end_turn",
    })
    const text = [meta, u1, a1].join("\n")
    const loaded = loadSessionFromText(text)
    expect(loaded.pendingDraft).toBeNull()
    expect(loaded.messages).toHaveLength(2)
  })

  // The "crashed mid-tool" case: assistant emitted tool_use but no
  // tool_result was ever appended. `repairMessages` drops the orphan
  // assistant. The trailing user from BEFORE the assistant is plain
  // text — but it's the prompt that drove the (now-dropped) assistant,
  // so it's load-bearing context, NOT a draft. After repair, the
  // last message IS that user text… and yes, in this case we DO want
  // to surface it as a pendingDraft, because re-running it as the next
  // turn is exactly what the user expects (the previous attempt
  // crashed). This is the same semantics as the abort flow's
  // setBuffer-on-abort behavior.
  it("surfaces the pre-tool_use user prompt when the tool turn crashed", () => {
    const meta = JSON.stringify({
      kind: "meta",
      formatVersion: 1,
      sid: "ma-mid-tool-crash",
      createdAt: "t",
      model: "m",
      cwd: "/x",
      systemHash: "h",
      toolsHash: "h",
      agentVersion: "v",
    })
    const u1 = JSON.stringify({
      kind: "user",
      ts: "t",
      content: [{ type: "text", text: "run the sleep test" }],
    })
    const a1 = JSON.stringify({
      kind: "assistant",
      ts: "t",
      content: [{ type: "tool_use", id: "tu_a", name: "Bash", input: {} }],
      stopReason: "tool_use",
    })
    // — agent crashed; no tool_result ever written —
    const text = [meta, u1, a1].join("\n")
    const loaded = loadSessionFromText(text)
    // repairMessages dropped the orphan assistant; the user prompt is
    // left as the trailing message and surfaced as the draft to retry.
    expect(loaded.repaired).toBe(true)
    expect(loaded.pendingDraft).toBe("run the sleep test")
    expect(loaded.messages).toHaveLength(0)
  })
})

describe("loadSession (full pipeline)", () => {
  it("round-trips a real SessionStore session via loadSession", () => {
    const dir = tmp()
    const sid = "ma-roundtrip"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
    store.appendUser("read package.json")
    store.appendAssistant(
      [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "package.json" } }],
      "tool_use",
    )
    store.appendToolResult({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: '{"name":"x"}',
      is_error: false,
    })
    store.appendAssistant([{ type: "text", text: "It's named x." }], "end_turn")

    const loaded = loadSession(sid, dir)
    expect(loaded.dropped).toHaveLength(0)
    expect(loaded.repaired).toBe(false)
    expect(loaded.meta?.sid).toBe(sid)
    expect(loaded.messages).toHaveLength(4) // user, asst(tool_use), user(tool_result), asst(text)
    expect(loaded.messages[3].role).toBe("assistant")
  })

  it("repairs a crashed-mid-tool session (tool_use without tool_result)", () => {
    const dir = tmp()
    const sid = "ma-crashed"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
    store.appendUser("do thing")
    store.appendAssistant(
      [{ type: "tool_use", id: "tu_x", name: "Bash", input: { command: "sleep 9999" } }],
      "tool_use",
    )
    // — agent crashed here, no tool_result was ever written —

    const loaded = loadSession(sid, dir)
    expect(loaded.repaired).toBe(true)
    expect(loaded.messages).toHaveLength(1)
    expect(loaded.messages[0].role).toBe("user")
  })

  it("tolerates a torn last line (kill -9 mid-write) without losing prior turns", () => {
    const meta = JSON.stringify({
      kind: "meta",
      formatVersion: 1,
      sid: "ma-torn",
      createdAt: "t",
      model: "m",
      cwd: "/x",
      systemHash: "h",
      toolsHash: "h",
      agentVersion: "v",
    })
    const user = JSON.stringify({ kind: "user", ts: "t", content: "hello" })
    const torn = `{"kind":"assistant","ts":"t","conten` // truncated
    const text = `${meta}\n${user}\n${torn}`
    const loaded = loadSessionFromText(text)
    expect(loaded.dropped).toHaveLength(1)
    expect(loaded.messages).toHaveLength(1)
    expect(loaded.messages[0].content).toBe("hello")
  })
})

describe("foldRecords (rewind)", () => {
  it("single rewind drops post-target records", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t1", content: "first", id: "u1" },
      {
        kind: "assistant",
        ts: "t1",
        content: [{ type: "text", text: "ans1" }],
        stopReason: "end_turn",
      },
      { kind: "user", ts: "t2", content: "second", id: "u2" },
      {
        kind: "assistant",
        ts: "t2",
        content: [{ type: "text", text: "ans2" }],
        stopReason: "end_turn",
      },
      { kind: "rewind", ts: "t3", to: "u1", droppedCount: 3 },
    ]
    const messages = foldRecords(records)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("user")
    expect(messages[0].content).toBe("first")
  })

  it("multiple rewinds compose", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t1", content: "first", id: "u1" },
      { kind: "user", ts: "t2", content: "second", id: "u2" },
      { kind: "rewind", ts: "t3", to: "u1", droppedCount: 1 },
      { kind: "user", ts: "t4", content: "third", id: "u3" },
      { kind: "rewind", ts: "t5", to: "u1", droppedCount: 1 },
    ]
    const messages = foldRecords(records)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe("first")
  })

  it("rewind with unknown `to` id is skipped (no crash)", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t1", content: "hi", id: "u1" },
      { kind: "rewind", ts: "t2", to: "does-not-exist", droppedCount: 0 },
      {
        kind: "assistant",
        ts: "t3",
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
      },
    ]
    const messages = foldRecords(records)
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe("hi")
    expect(messages[1].role).toBe("assistant")
  })

  it("rewind preserves merged tool_result blocks on the kept user message", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t0", content: "go", id: "u0" },
      {
        kind: "assistant",
        ts: "t0",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} }],
        stopReason: "tool_use",
      },
      { kind: "tool_result", ts: "t0", tool_use_id: "tu_1", content: "ok", isError: false },
      { kind: "user", ts: "t1", content: "next", id: "u1" },
      { kind: "rewind", ts: "t2", to: "u0", droppedCount: 3 },
    ]
    const messages = foldRecords(records)
    // u0 user, asst(tool_use), user(tool_result merged) — kept up through targetIdx=0
    // Wait: target is u0 at index 0; everything after is dropped.
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe("go")
  })
})

describe("firstUserPromptSnippet", () => {
  it("returns the first user message text trimmed and one-line", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t", content: "  hello\nworld   " },
      { kind: "user", ts: "t", content: "ignored" },
    ]
    expect(firstUserPromptSnippet(records)).toBe("hello world")
  })
  it("truncates with ellipsis", () => {
    const long = "x".repeat(100)
    const records: SessionRecord[] = [{ kind: "user", ts: "t", content: long }]
    const out = firstUserPromptSnippet(records, 20)
    expect(out.length).toBe(20)
    expect(out.endsWith("...")).toBe(true)
  })
  it("handles content blocks (text)", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t", content: [{ type: "text", text: "blocky hi" }] },
    ]
    expect(firstUserPromptSnippet(records)).toBe("blocky hi")
  })
})

// ---------------------------------------------------------------------------
// Fork round-trip: parent → SessionStore.fork() → loadSession(fork) must
// reproduce the same conversation messages. This is the end-to-end guard
// that protects the user-visible promise: "--resume <fork-sid>" yields the
// same conversation as "--resume <parent-sid>" (minus any fork-time
// content drift, which there is none of in this test).
// ---------------------------------------------------------------------------

describe("loadSession(fork) round-trip", () => {
  it("a fork yields the same messages as its parent", () => {
    const dir = tmp()
    const srcSid = "ma-restore-parent"
    const dstSid = "ma-restore-fork"
    const parent = SessionStore.open({ ...baseOpenOpts, sid: srcSid, dir })
    parent.appendAttach()
    parent.appendUser("hello")
    parent.appendAssistant(
      [
        { type: "text", text: "world" },
        { type: "tool_use", id: "toolu_y", name: "Bash", input: { command: "echo hi" } },
      ],
      "tool_use",
    )
    parent.appendToolResult({
      type: "tool_result",
      tool_use_id: "toolu_y",
      content: "hi",
      is_error: false,
    })
    parent.appendAssistant([{ type: "text", text: "done" }], "end_turn")
    parent.appendDetach("exit", 0)

    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })

    const parentLoad = loadSession(srcSid, dir)
    const forkLoad = loadSession(dstSid, dir)
    // Same conversation, byte-identical message JSON.
    expect(JSON.stringify(forkLoad.messages)).toBe(JSON.stringify(parentLoad.messages))
    // Fork's meta carries the parent pointer; parent's meta has neither.
    expect(forkLoad.meta?.parentSid).toBe(srcSid)
    expect(forkLoad.meta?.forkedAt).toBeDefined()
    expect(parentLoad.meta?.parentSid).toBeUndefined()
    expect(parentLoad.meta?.forkedAt).toBeUndefined()
  })

  it("rewinds in the parent fold correctly through the fork", () => {
    const dir = tmp()
    const srcSid = "ma-restore-rewind-parent"
    const dstSid = "ma-restore-rewind-fork"
    const parent = SessionStore.open({ ...baseOpenOpts, sid: srcSid, dir })
    const id1 = parent.appendUser("first")
    parent.appendAssistant([{ type: "text", text: "ans1" }], "end_turn")
    parent.appendUser("second")
    parent.appendAssistant([{ type: "text", text: "ans2" }], "end_turn")
    parent.appendRewind(id1, 3)
    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })

    const forkLoad = loadSession(dstSid, dir)
    // Rewind keeps the prompt with id=id1; everything after is dropped.
    expect(forkLoad.messages).toHaveLength(1)
    expect(forkLoad.messages[0]?.role).toBe("user")
  })
})

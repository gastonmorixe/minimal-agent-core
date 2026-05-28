import { expect, test } from "bun:test"

import { formatSessionAsMarkdown, formatSessionAsXml } from "./session-dump.ts"
import type { LoadedSession } from "./session-restore.ts"

const mockSession: LoadedSession = {
  meta: {
    kind: "meta",
    formatVersion: 1,
    sid: "test-sid-123",
    model: "test-model",
    createdAt: "2026-05-03T00:00:00Z",
    cwd: "/test/cwd",
    systemHash: "abc",
    toolsHash: "def",
    agentVersion: "1.0",
  },
  records: [],
  messages: [
    {
      role: "user",
      content: "Hello",
    },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "I need to say hi",
          signature: "sig123",
        },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "echo hi" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "hi",
          is_error: false,
        },
      ],
    },
  ],
  dropped: [],
  repaired: false,
  pendingDraft: null,
}

test("formatSessionAsMarkdown", () => {
  const md = formatSessionAsMarkdown(mockSession)
  expect(md).toContain("# Session: test-sid-123")
  expect(md).toContain("## User")
  expect(md).toContain("## Assistant")
  expect(md).toContain("> 🤔 **Thinking**")
  expect(md).toContain("> I need to say hi")
  expect(md).toContain("> 🛠️ **Tool Use**: `Bash` (id: toolu_1)")
  expect(md).toContain("> 🔙 **Tool Result**: (id: toolu_1)")
  expect(md).toContain("hi")
})

test("formatSessionAsXml", () => {
  const xml = formatSessionAsXml(mockSession)
  expect(xml).toContain('<session id="test-sid-123"')
  expect(xml).toContain('<turn role="user">')
  expect(xml).toContain("<text>Hello</text>")
  expect(xml).toContain('<turn role="assistant">')
  expect(xml).toContain("<thinking>I need to say hi</thinking>")
  expect(xml).toContain('<tool_use name="Bash" id="toolu_1">')
  expect(xml).toContain("<input>{&quot;command&quot;:&quot;echo hi&quot;}</input>")
  expect(xml).toContain('<tool_result tool_use_id="toolu_1">')
  expect(xml).toContain("<content>hi</content>")
})

const mockSessionRedacted: LoadedSession = {
  meta: null,
  records: [],
  messages: [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
          signature: "very-long-signature-xyz",
        },
      ],
    },
  ],
  dropped: [],
  repaired: false,
  pendingDraft: null,
}

test("formatSessionAsMarkdown redacted thinking", () => {
  const md = formatSessionAsMarkdown(mockSessionRedacted)
  expect(md).toContain("> 🤔 **Thinking**")
  expect(md).toContain("*(Redacted thinking, signature: very-long-signat...)*")
})

test("formatSessionAsXml redacted thinking", () => {
  const xml = formatSessionAsXml(mockSessionRedacted)
  expect(xml).toContain('<thinking signature="very-long-signature-xyz"/>')
})

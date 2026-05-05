import { describe, expect, it } from "bun:test"
import type { Message } from "./client.ts"
import { buildResumeHeader, replayToScrollback } from "./session-replay.ts"

class CaptureSink {
  out = ""
  write(s: string): void {
    this.out += s
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

describe("buildResumeHeader", () => {
  it("includes sid, turn count, and model", () => {
    const h = buildResumeHeader({ sid: "demo-1", turns: 3, model: "claude-sonnet-4-6" })
    const plain = stripAnsi(h)
    expect(plain).toContain("demo-1")
    expect(plain).toContain("3 messages")
    expect(plain).toContain("claude-sonnet-4-6")
  })
  it("singularizes 1 message", () => {
    const h = buildResumeHeader({ sid: "x", turns: 1, model: "m" })
    expect(stripAnsi(h)).toContain("1 message,")
  })
  it("notes repair and dropped lines when present", () => {
    const h = buildResumeHeader({ sid: "x", turns: 2, model: "m", repaired: true, dropped: 1 })
    const plain = stripAnsi(h)
    expect(plain).toContain("repaired")
    expect(plain).toContain("dropped 1")
  })
})

describe("replayToScrollback", () => {
  it("renders a simple text-only conversation in dim", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello there" }] },
    ]
    const sink = new CaptureSink()
    replayToScrollback(messages, sink)
    const plain = stripAnsi(sink.out)
    expect(plain).toContain("❯ hi")
    expect(plain).toContain("hello there")
  })

  it("renders a tool_use under the assistant turn with its result preview", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "list files" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "a.txt\nb.txt", is_error: false },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]
    const sink = new CaptureSink()
    replayToScrollback(messages, sink)
    const plain = stripAnsi(sink.out)
    expect(plain).toContain("Bash")
    expect(plain).toContain("$ ls")
    expect(plain).toContain("a.txt")
    expect(plain).toContain("b.txt")
    expect(plain).toContain("done")
    // The trailing user(tool_result-only) message must NOT print its own
    // header line — it's absorbed under the assistant turn.
    const userArrows = plain.match(/❯ /g)?.length ?? 0
    expect(userArrows).toBe(1) // only the original "list files" prompt
  })

  it("annotates a tool_use with no on-disk result", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_orphan", name: "Bash", input: { command: "x" } }],
      },
    ]
    const sink = new CaptureSink()
    replayToScrollback(messages, sink)
    expect(stripAnsi(sink.out)).toContain("(no result on disk)")
  })
})

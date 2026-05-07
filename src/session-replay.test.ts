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

  it("strips <mode-change> activation blocks and uses the per-mode prompt prefix", async () => {
    const { ModeManager } = await import("./modes.ts")
    const ASK_MANIFEST = { id: "ask", label: "ASK" }
    const modeManager = new ModeManager([ASK_MANIFEST])
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: '<mode-change from="default" to="ask" />' },
          { type: "text", text: "ask question" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      {
        role: "user",
        content: [{ type: "text", text: "follow-up still in ask" }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: '<mode-change from="ask" to="default" />' },
          { type: "text", text: "back to default" },
        ],
      },
    ]
    const sink = new CaptureSink()
    replayToScrollback(messages, sink, { modeManager })
    const plain = stripAnsi(sink.out)
    // The activation tag itself never reaches the rendered output.
    expect(plain).not.toContain("<mode-change")
    // First turn renders under the ASK prompt prefix.
    expect(plain).toContain("ASK ❯ ask question")
    // Follow-up turn (no <mode-change>) inherits the prior mode.
    expect(plain).toContain("ASK ❯ follow-up still in ask")
    // After mode-change to default, the prefix returns to the bare arrow…
    expect(plain).toContain("❯ back to default")
    // …and specifically NOT under an ASK label.
    expect(plain).not.toContain("ASK ❯ back to default")
  })

  it("ignores a tool_result-only user message that also carries a <mode-change> block", async () => {
    const { ModeManager } = await import("./modes.ts")
    const ASK_MANIFEST = { id: "ask", label: "ASK" }
    const modeManager = new ModeManager([ASK_MANIFEST])
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "kick off" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false },
          { type: "text", text: '<mode-change from="default" to="ask" />' },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "now in ask" }],
      },
    ]
    const sink = new CaptureSink()
    replayToScrollback(messages, sink, { modeManager })
    const plain = stripAnsi(sink.out)
    // The mid-loop user message (tool_result + mode-change) renders no
    // own header line, but its mode-change side effect carries forward.
    expect(plain).not.toContain("<mode-change")
    expect(plain).toContain("ASK ❯ now in ask")
    // Only two `❯ ` arrows total: the kickoff and the post-toggle prompt.
    const arrows = plain.match(/❯ /g)?.length ?? 0
    expect(arrows).toBe(2)
  })

  it("falls back to the bare arrow when no modeManager is supplied (back-compat)", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: '<mode-change from="default" to="ask" />' },
          { type: "text", text: "no manager" },
        ],
      },
    ]
    const sink = new CaptureSink()
    replayToScrollback(messages, sink)
    const plain = stripAnsi(sink.out)
    // Activation tag is still stripped (it's a transport detail)…
    expect(plain).not.toContain("<mode-change")
    // …and the prompt falls back to the bare arrow rather than crashing.
    expect(plain).toContain("❯ no manager")
    expect(plain).not.toContain("ASK ❯")
  })
})

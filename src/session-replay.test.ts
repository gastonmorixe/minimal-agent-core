import { describe, expect, it } from "bun:test"
import type { Message } from "./client.ts"
import { buildResumeHeader, replayToScrollback } from "./session-replay.ts"
import { ToolTimeTracker } from "./tool-time.ts"

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
  it("renders a simple text-only conversation in dim", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello there" }] },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink)
    const plain = stripAnsi(sink.out)
    expect(plain).toContain("❯ hi")
    expect(plain).toContain("hello there")
  })

  it("renders a tool_use under the assistant turn with its result preview", async () => {
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
    await replayToScrollback(messages, sink)
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

  it("annotates a tool_use with no on-disk result", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_orphan", name: "Bash", input: { command: "x" } }],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink)
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
    await replayToScrollback(messages, sink, { modeManager })
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
    await replayToScrollback(messages, sink, { modeManager })
    const plain = stripAnsi(sink.out)
    // The mid-loop user message (tool_result + mode-change) renders no
    // own header line, but its mode-change side effect carries forward.
    expect(plain).not.toContain("<mode-change")
    expect(plain).toContain("ASK ❯ now in ask")
    // Only two `❯ ` arrows total: the kickoff and the post-toggle prompt.
    const arrows = plain.match(/❯ /g)?.length ?? 0
    expect(arrows).toBe(2)
  })

  it("falls back to the bare arrow when no modeManager is supplied (back-compat)", async () => {
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
    await replayToScrollback(messages, sink)
    const plain = stripAnsi(sink.out)
    // Activation tag is still stripped (it's a transport detail)…
    expect(plain).not.toContain("<mode-change")
    // …and the prompt falls back to the bare arrow rather than crashing.
    expect(plain).toContain("❯ no manager")
    expect(plain).not.toContain("ASK ❯")
  })

  // ──────────────────────────────────────────────────────────────────
  // Formatter pass-through (the resume-doesn't-render-markdown bugfix).
  //
  // These tests use a fake formatter subprocess (`bun -e "…"`) that
  // wraps stdin in `FMT[…]` markers. If `formatterCmd` is plumbed
  // through correctly, every assistant text/thinking block ends up
  // wrapped — proving the bytes actually went through the subprocess
  // pipeline rather than being written raw to the sink. Same pattern
  // used by `src/agent.test.ts`'s "renders native thinking chunks
  // through the formatter" test.
  // ──────────────────────────────────────────────────────────────────

  const FAKE_FORMATTER_CMD = [
    "bun",
    "-e",
    "let s = ''; const d = new TextDecoder(); for await (const chunk of Bun.stdin.stream()) s += d.decode(chunk); process.stdout.write('FMT[' + s + ']\\n')",
  ]

  it("pipes assistant text blocks through the formatter when formatterCmd is set", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "**hello** there" }] },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { formatterCmd: FAKE_FORMATTER_CMD })
    expect(sink.out).toContain("FMT[**hello** there]")
    // User prompt line is NOT piped through the formatter — only
    // assistant text/thinking. The raw user text must be present.
    expect(stripAnsi(sink.out)).toContain("❯ hi")
    expect(sink.out).not.toContain("FMT[hi]")
  })

  it("spawns a fresh formatter per text block to mirror the live onTextStop boundary", async () => {
    // Two text blocks in ONE assistant turn must each get wrapped
    // independently (`FMT[…]` per block), proving start+end ran twice
    // — not once with both blocks concatenated.
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { formatterCmd: FAKE_FORMATTER_CMD })
    expect(sink.out).toContain("FMT[first]")
    expect(sink.out).toContain("FMT[second]")
    expect(sink.out).not.toContain("FMT[firstsecond]")
  })

  it("pipes assistant thinking blocks through the formatter when formatterCmd is set", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "think" }] },
      {
        role: "assistant",
        content: [
          // Use the `thinking` block shape `replayToScrollback` reads:
          // `(b as { thinking?: string }).thinking`.
          { type: "thinking", thinking: "let me see" } as unknown as never,
        ],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { formatterCmd: FAKE_FORMATTER_CMD })
    expect(sink.out).toContain("FMT[let me see]")
    // Thinking output is wrapped in faint+italic ANSI (faintThinkingChunk).
    // `\x1b[2m` = faint, `\x1b[3m` = italic. Sanity-check the wrap is
    // applied to the formatter's emitted chunk.
    expect(sink.out).toMatch(/\x1b\[2m.*FMT\[let me see\]/)
  })

  it("does not spawn a formatter for empty text/thinking blocks", async () => {
    // Spawning a subprocess for a zero-byte block would be wasteful
    // and could pollute the sink with an empty `FMT[]`. Skip them.
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "x" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "thinking", thinking: "" } as unknown as never,
          { type: "text", text: "after" },
        ],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { formatterCmd: FAKE_FORMATTER_CMD })
    expect(sink.out).toContain("FMT[after]")
    expect(sink.out).not.toContain("FMT[]")
  })

  it("falls back to raw writes (back-compat) when formatterCmd is not set", async () => {
    // The legacy no-formatter path: each text block writes `${text}\n`
    // and each thinking block writes `${faintThinkingChunk(text)}\n`
    // directly, with NO `FMT[…]` wrapping (no subprocess).
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "**raw** markdown" },
          { type: "thinking", thinking: "think raw" } as unknown as never,
        ],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink)
    expect(sink.out).toContain("**raw** markdown")
    expect(sink.out).not.toContain("FMT[")
  })

  it("appends ` · <time>` to tool_use header when tracker + startTimes are wired", async () => {
    // Two tool_uses on the same calendar day. The first should carry the
    // cold-start "Mon DD HH:MM:SS" form; the second drops the date prefix.
    // The tracker IS shared with the (hypothetical) live agent that comes
    // after replay — that's the whole point of accepting it as an option.
    const tu1Ms = new Date(2026, 4, 14, 15, 42, 3).getTime() // May 14 15:42:03
    const tu2Ms = new Date(2026, 4, 14, 15, 42, 7).getTime() // May 14 15:42:07
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_replay_a", name: "Bash", input: { command: "true" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_replay_a", content: "", is_error: false },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_replay_b", name: "Bash", input: { command: "true" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_replay_b", content: "", is_error: false },
        ],
      },
    ]
    const tracker = new ToolTimeTracker()
    const startTimes = new Map([
      ["tu_replay_a", tu1Ms],
      ["tu_replay_b", tu2Ms],
    ])
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, {
      toolTimeTracker: tracker,
      toolStartTimes: startTimes,
    })
    const plain = stripAnsi(sink.out)
    // First tool: cold-start, includes "May 14".
    expect(plain).toContain("· May 14 15:42:03")
    // Second tool: same calendar day, bare HH:MM:SS only.
    expect(plain).toContain("· 15:42:07")
    // The "May 14" prefix must NOT recur on the second tool.
    expect(plain.match(/May 14/g)?.length ?? 0).toBe(1)
  })

  it("emits NO time hint when toolTimeTracker is omitted (back-compat)", async () => {
    // Same input shape, but no tracker/startTimes → headers stay clean.
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_no_hint", name: "Bash", input: { command: "true" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_no_hint", content: "", is_error: false }],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, {
      // tracker provided but no startTimes → still no hint, no crash
      toolTimeTracker: new ToolTimeTracker(),
    })
    const plain = stripAnsi(sink.out)
    expect(plain).not.toMatch(/ · \d{2}:\d{2}:\d{2}/)
    expect(plain).not.toMatch(
      /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2}/,
    )
  })

  it("skips the time hint silently when a tool_use_id is missing from startTimes", async () => {
    // The lookup is best-effort: a tool_use whose AssistantRecord lost
    // its `ts` (or whose record was filtered) just renders without the
    // suffix instead of crashing or printing "undefined".
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_known", name: "Bash", input: { command: "true" } },
          { type: "tool_use", id: "tu_unknown", name: "Bash", input: { command: "true" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_known", content: "", is_error: false },
          { type: "tool_result", tool_use_id: "tu_unknown", content: "", is_error: false },
        ],
      },
    ]
    const knownMs = new Date(2026, 5, 1, 10, 0, 0).getTime() // Jun 1 10:00:00
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, {
      toolTimeTracker: new ToolTimeTracker(),
      toolStartTimes: new Map([["tu_known", knownMs]]),
    })
    const plain = stripAnsi(sink.out)
    expect(plain).toContain("· Jun 1 10:00:00")
    // The unknown tool's header still renders, just without a hint.
    // Sanity: there's only ONE timestamp suffix across the whole output —
    // the regex matches both "· Jun 1 10:00:00" (cold-start form) and
    // "· HH:MM:SS" (steady-state form).
    const suffixRe = / · (?:[A-Z][a-z]{2} \d{1,2} )?\d{2}:\d{2}:\d{2}/g
    expect(plain.match(suffixRe)?.length ?? 0).toBe(1)
  })
})

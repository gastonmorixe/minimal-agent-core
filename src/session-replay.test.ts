import { describe, expect, it } from "bun:test"

import type { Message } from "./client/types.ts"
import { buildResumeHeader, replayToScrollback, stringifyUserText } from "./session-replay.ts"
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
    const h = buildResumeHeader({ sid: "demo-1", turns: 3, model: "test-model-1" })
    const plain = stripAnsi(h)
    expect(plain).toContain("demo-1")
    expect(plain).toContain("3 messages")
    expect(plain).toContain("test-model-1")
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

  it("parses <mode-change> blocks that include the at= timestamp attribute", async () => {
    // Forward-compat: new logs carry `at="..."`. The replay should treat
    // them identically to the legacy no-`at` form (strip + thread mode).
    const { ModeManager } = await import("./modes.ts")
    const ASK_MANIFEST = { id: "ask", label: "ASK" }
    const modeManager = new ModeManager([ASK_MANIFEST])
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<mode-change from="default" to="ask" at="2026-05-22T20:43:12.000Z" />',
          },
          { type: "text", text: "ask question" },
        ],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { modeManager })
    const plain = stripAnsi(sink.out)
    expect(plain).not.toContain("<mode-change")
    expect(plain).toContain("ASK ❯ ask question")
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
  // Runtime-attachment stripping. The agent prepends several
  // model-only attachment blocks to user messages (see Agent.run in
  // src/agent.ts). On --resume these MUST NOT leak into the scrollback
  // as if the user typed them.
  // ──────────────────────────────────────────────────────────────────

  it("strips <ma::plugin::tasks> attachment from the rendered user turn", async () => {
    const tasksAttachment =
      '<ma::plugin::tasks total="2" done="0" doing="1" todo="1" canceled="0">\n' +
      "1  #abc123  doing  Phase 1: types.ts\n" +
      "2  #def456  todo   Phase 2: palette.ts\n" +
      "</ma::plugin::tasks>"
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: tasksAttachment },
          { type: "text", text: "keep going" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink)
    const plain = stripAnsi(sink.out)
    // The attachment must not appear, neither the opener nor any
    // of its body lines.
    expect(plain).not.toContain("<ma::plugin::tasks")
    expect(plain).not.toContain("</ma::plugin::tasks>")
    expect(plain).not.toContain("Phase 1: types.ts")
    expect(plain).not.toContain("Phase 2: palette.ts")
    // The actual user text still renders cleanly under a single arrow.
    expect(plain).toContain("❯ keep going")
    const arrows = plain.match(/❯ /g)?.length ?? 0
    expect(arrows).toBe(1)
  })

  it("strips <ma::plugin::memory::short-term> attachment from the rendered user turn", async () => {
    const stmAttachment =
      "<ma::plugin::memory::short-term>\n[#1] hypothesis: wrap bug only at COLUMNS<80\n</ma::plugin::memory::short-term>"
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: stmAttachment },
          { type: "text", text: "what next?" },
        ],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink)
    const plain = stripAnsi(sink.out)
    expect(plain).not.toContain("<ma::plugin::memory::short-term")
    expect(plain).not.toContain("hypothesis: wrap bug")
    expect(plain).toContain("❯ what next?")
  })

  it("strips <memory-saved> save-echo blocks from the rendered user turn", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<memory-saved scope="project" id="lwq8tg-a8f3">tests live in src/*.test.ts</ma::plugin::memory::saved>',
          },
          {
            type: "text",
            text: '<memory-saved scope="short-term" id="2" evicted="1">trying LANG=C</ma::plugin::memory::saved>',
          },
          { type: "text", text: "carry on" },
        ],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink)
    const plain = stripAnsi(sink.out)
    expect(plain).not.toContain("<memory-saved")
    expect(plain).not.toContain("tests live in src")
    expect(plain).not.toContain("LANG=C")
    expect(plain).toContain("❯ carry on")
  })

  it("strips a tool_result + <ma::agent::reflection-checkpoint> user turn (no own arrow row)", async () => {
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
          {
            type: "text",
            text:
              '<ma::agent::reflection-checkpoint round="50" cooldown-applied-seconds="60" />\n' +
              "Soft checkpoint, not a stop signal. Briefly consider whether you are still on track.",
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "still on track" }] },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink)
    const plain = stripAnsi(sink.out)
    // Neither the tag nor the prose body sneaks into the scrollback.
    expect(plain).not.toContain("<ma::agent::reflection-checkpoint")
    expect(plain).not.toContain("Soft checkpoint")
    // The mid-loop user turn renders no own arrow row (it's a
    // tool_result + attachment pairing with no user payload).
    const arrows = plain.match(/❯ /g)?.length ?? 0
    expect(arrows).toBe(1) // only the original "kick off" prompt
    expect(plain).toContain("still on track")
  })

  it("strips a mixed bag of attachments (mode-change + short-term + tasks + memory-saved + user text)", async () => {
    // Mirror the exact ordering Agent.run uses at the initial seam:
    // mode-change, ma::plugin::memory::short-term, ma::plugin::tasks, memory-saved, user text.
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: '<mode-change from="default" to="ask" />' },
          {
            type: "text",
            text: "<ma::plugin::memory::short-term>\n[#1] note\n</ma::plugin::memory::short-term>",
          },
          {
            type: "text",
            text:
              '<ma::plugin::tasks total="1" done="0" doing="1" todo="0" canceled="0">\n' +
              "1  #abc123  doing  do the thing\n" +
              "</ma::plugin::tasks>",
          },
          {
            type: "text",
            text: '<memory-saved scope="project" id="x-1">prior save</ma::plugin::memory::saved>',
          },
          { type: "text", text: "all done?" },
        ],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink)
    const plain = stripAnsi(sink.out)
    expect(plain).not.toContain("<mode-change")
    expect(plain).not.toContain("<ma::plugin::memory::short-term")
    expect(plain).not.toContain("<ma::plugin::tasks")
    expect(plain).not.toContain("<memory-saved")
    expect(plain).not.toContain("[#1] note")
    expect(plain).not.toContain("do the thing")
    expect(plain).not.toContain("prior save")
    // Exactly one rendered arrow row, carrying just the user's text.
    expect(plain).toContain("❯ all done?")
    const arrows = plain.match(/❯ /g)?.length ?? 0
    expect(arrows).toBe(1)
  })

  // Regression: stringifyUserText must filter the CURRENT canonical
  // <ma::agent::tasks> schema (not just the old <ma::plugin::tasks> one).
  // A user message with a prepended tasks block should render only the
  // user's text in scrollback during --resume.
  it("stringifyUserText strips <ma::agent::tasks> (the live schema)", () => {
    const { text } = stringifyUserText(
      [
        {
          type: "text",
          text: '<ma::agent::tasks total="3" done="3" doing="0" todo="0" canceled="0">\n1  #94b14e   done   Investigate display-override path\n2  #1cf3c6   done   Investigate the normal content path\n3  #faaabe   done   Catalog all callers\n</ma::agent::tasks>',
        },
        { type: "text", text: "real user question" },
      ],
      null,
    )
    expect(text).not.toContain("<ma::agent::")
    expect(text).not.toContain("#94b14e")
    expect(text).not.toContain("display-override path")
    expect(text).toContain("real user question")
  })

  // Also verify the full integration: replayToScrollback with the live schema.
  it("replayToScrollback strips <ma::agent::tasks> blocks from user messages", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              '<ma::agent::tasks total="1" done="0" doing="0" todo="1" canceled="0">\n' +
              "1  #abc123  todo  do the thing\n" +
              "</ma::agent::tasks>",
          },
          { type: "text", text: "carry on" },
        ],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink)
    const plain = stripAnsi(sink.out)
    expect(plain).not.toContain("<ma::agent::tasks")
    expect(plain).not.toContain("#abc123")
    expect(plain).not.toContain("do the thing")
    expect(plain).toContain("carry on")
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

  it("emits a mode-change chip with the user-record timestamp when replayed", async () => {
    const { ModeManager } = await import("./modes.ts")
    const ASK_MANIFEST = { id: "ask", label: "ASK" }
    const modeManager = new ModeManager([ASK_MANIFEST])
    const at = new Date(2026, 4, 22, 17, 52, 30)
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: '<mode-change from="default" to="ask" />' },
          { type: "text", text: "ask question" },
        ],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { modeManager, userTimestamps: [at] })
    const plain = stripAnsi(sink.out)
    // The chip is emitted ABOVE the prompt arrow with `mode <from> → <to>`.
    expect(plain).toContain("mode")
    expect(plain).toContain("default → ASK")
    // Timestamp from the user-record `ts`, formatted as YYYY-MM-DD HH:MM.
    expect(plain).toContain("2026-05-22 17:52")
    // The tag itself never leaks into the rendered output.
    expect(plain).not.toContain("<mode-change")
    // The prompt arrow + user text still renders below the chip.
    expect(plain).toContain("ASK ❯ ask question")
    // Chip appears BEFORE the prompt arrow in the rendered output.
    const chipIdx = plain.indexOf("default → ASK")
    const arrowIdx = plain.indexOf("ASK ❯")
    expect(chipIdx).toBeGreaterThanOrEqual(0)
    expect(arrowIdx).toBeGreaterThan(chipIdx)
  })

  it("emits a chip for a tool_result-only user message that carries a mode-change", async () => {
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
    const at = new Date(2026, 4, 22, 17, 52)
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, {
      modeManager,
      // Index 2 is the synthetic tool_result+mode-change user message.
      userTimestamps: [null, null, at, null],
    })
    const plain = stripAnsi(sink.out)
    expect(plain).toContain("default → ASK")
    expect(plain).toContain("2026-05-22 17:52")
    expect(plain).toContain("ASK ❯ now in ask")
  })

  it("falls back to epoch 1970 when the timestamp slot is null", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: '<mode-change from="default" to="ask" />' },
          { type: "text", text: "hello" },
        ],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { userTimestamps: [null] })
    const plain = stripAnsi(sink.out)
    expect(plain).toContain("default → ASK")
    // 1970-01-01 is the documented "we lost the timestamp" marker.
    expect(plain).toContain("1970-01-01")
  })

  it("renders chip even without a modeManager (uses uppercased ids)", async () => {
    const at = new Date(2026, 4, 22, 17, 52)
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: '<mode-change from="default" to="ask" />' },
          { type: "text", text: "hello" },
        ],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { userTimestamps: [at] })
    const plain = stripAnsi(sink.out)
    // No modeManager → label is uppercased id, no color, but chip still renders.
    expect(plain).toContain("mode")
    expect(plain).toContain("default → ASK")
    expect(plain).toContain("2026-05-22 17:52")
  })
})

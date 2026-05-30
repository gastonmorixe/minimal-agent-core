import { describe, expect, it } from "bun:test"

import type { Message } from "./client.ts"
import {
  buildResumeHeader,
  replayToScrollback,
  toolDisplaysFromRecords,
  userTimestampsFromRecords,
} from "./session-replay.ts"
import type { SessionRecord } from "./session-store.ts"
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

describe("replayToScrollback — tool presentation parity", () => {
  // Regression: before this fix, --resume dropped the tool header's
  // icon (» / ✦ / ✔) and color, falling back to the bare bold tool
  // name in orange regardless of the tool's manifest. The snapshot
  // diff captured `╭ Bash` instead of `╭ » Bash` for Bash, and the
  // same kind of icon-less row for Edit (✦) and Task (✔).
  it("renders the manifest icon prefix on the ╭ header (Bash/»)", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "a", is_error: false }],
      },
    ]
    const presentation = new Map([["Bash", { icon: "»", color: "orange" }]])
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { toolPresentation: presentation })
    const plain = stripAnsi(sink.out)
    // The icon sits between `╭ ` and the tool name.
    expect(plain).toMatch(/╭ » Bash/)
  })

  it("falls back to the bare tool name (no icon) when no presentation map is supplied", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "a", is_error: false }],
      },
    ]
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink)
    const plain = stripAnsi(sink.out)
    // Bare bold name (no `»`) when the caller didn't pass a presentation map.
    expect(plain).toMatch(/╭ Bash/)
    expect(plain).not.toMatch(/╭ » Bash/)
  })

  it("renders the icon for every tool name present in the map (Edit/✦, Task/✔)", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "do work" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_edit",
            name: "Edit",
            input: { file_path: "/x", old_string: "a", new_string: "b" },
          },
          { type: "tool_use", id: "tu_task", name: "Task", input: { action: "done", id: "#abc" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_edit", content: "edited", is_error: false },
          { type: "tool_result", tool_use_id: "tu_task", content: "ok", is_error: false },
        ],
      },
    ]
    const presentation = new Map([
      ["Edit", { icon: "✦", color: "gold" }],
      ["Task", { icon: "✔", color: "lime" }],
    ])
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { toolPresentation: presentation })
    const plain = stripAnsi(sink.out)
    expect(plain).toMatch(/╭ ✦ Edit/)
    expect(plain).toMatch(/╭ ✔ Task/)
  })

  it("renders an unknown color name in the default orange (graceful fallback)", async () => {
    // The live agent does the same: an unknown color key just no-ops to orange.
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }],
      },
    ]
    const presentation = new Map([["Bash", { icon: "»", color: "not-a-real-color" }]])
    const sink = new CaptureSink()
    // Should not throw : the renderer must tolerate unknown color names.
    await replayToScrollback(messages, sink, { toolPresentation: presentation })
    expect(stripAnsi(sink.out)).toMatch(/╭ » Bash/)
  })
})

describe("replayToScrollback — display / displayHeader / displayFooter parity", () => {
  // Regression: before this fix, --resume rendered the model-facing
  // `content` text in place of the live transcript's `display` field.
  // For Edit, that meant "File edited: ..." replaced the unified diff;
  // for Task, the raw JSON args replaced "✔ ALL DONE · 39/39 · ..."
  // in the header AND the task tree was replaced by truncated content.
  it("uses display from the sidecar map as the tool body (Edit diff survives resume)", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "make the change" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_edit",
            name: "Edit",
            input: { file_path: "/x.json", old_string: "old", new_string: "new" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_edit",
            content: "File edited: /x.json (1 replacement(s))",
            is_error: false,
          },
        ],
      },
    ]
    const diffBody = "--- a//x.json\n+++ b//x.json\n@@\n-old\n+new"
    const toolDisplays = new Map([["tu_edit", { display: diffBody }]])
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { toolDisplays })
    const plain = stripAnsi(sink.out)
    // The diff lines must appear in the rendered body…
    expect(plain).toContain("--- a//x.json")
    expect(plain).toContain("+++ b//x.json")
    expect(plain).toContain("-old")
    expect(plain).toContain("+new")
    // …and the model-facing "File edited" text must NOT (it's only what
    // the model saw, never what the user saw in the live transcript).
    expect(plain).not.toContain("File edited")
  })

  it("uses displayHeader as the header content slot (Task summary survives resume)", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "mark done" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_task",
            name: "Task",
            input: { action: "done", id: "#56b7b5" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_task",
            content: '{"action":"done","id":"#56b7b5"}',
            is_error: false,
          },
        ],
      },
    ]
    const taskHeader = "✔ ALL DONE · 39/39 · 2026-05-28 08:29:05"
    const taskTreeBody = "   8  ✔  #56b7b5  Final verification\n      ├  ✔  #56b7b5a  Run check"
    const toolDisplays = new Map([
      ["tu_task", { display: taskTreeBody, displayHeader: taskHeader }],
    ])
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { toolDisplays })
    const plain = stripAnsi(sink.out)
    // The header summary replaces the raw JSON args…
    expect(plain).toContain("✔ ALL DONE · 39/39 · 2026-05-28 08:29:05")
    expect(plain).not.toMatch(/╭.*\{"action":"done"/)
    // …and the rich body replaces the model-facing JSON.
    expect(plain).toContain("Final verification")
    expect(plain).toContain("#56b7b5a")
  })

  it("uses displayFooter as the trailing footer row when supplied", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "search" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_q", name: "WebSearch", input: { query: "claude" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_q", content: "raw model body", is_error: false },
        ],
      },
    ]
    const toolDisplays = new Map([
      [
        "tu_q",
        {
          display: "result 1\nresult 2",
          displayFooter: "WebSearch[brave/web] · 2 hits · 312ms",
        },
      ],
    ])
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { toolDisplays })
    const plain = stripAnsi(sink.out)
    expect(plain).toContain("result 1")
    expect(plain).toContain("result 2")
    expect(plain).toContain("WebSearch[brave/web] · 2 hits · 312ms")
    // Footer attaches directly to the `╰` closer in the `display`
    // branch (no `┊` separator — that's the truncation-only path).
    expect(plain).toMatch(/╰ WebSearch\[brave\/web\]/)
  })

  it("falls back to content when no toolDisplays entry exists (back-compat for old sessions)", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
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
    ]
    const sink = new CaptureSink()
    // Pass an empty map : the code path is taken but no entry matches.
    await replayToScrollback(messages, sink, { toolDisplays: new Map() })
    const plain = stripAnsi(sink.out)
    expect(plain).toContain("a.txt")
    expect(plain).toContain("b.txt")
  })

  it("skips the soft-split continuation rows when displayHeader takes over (plugin owns the row)", async () => {
    // Long Bash command that would normally trigger `↳` continuation rows.
    // When displayHeader is supplied the plugin owns the header rendering
    // entirely, so the continuation rows must NOT be emitted — matching
    // the live agent's `writeToolHeader(override)` semantics.
    const longCmd = "echo aaaaa && echo bbbbb && echo ccccc && echo ddddd && echo eeeee"
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "do it" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: longCmd } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "done", is_error: false }],
      },
    ]
    const toolDisplays = new Map([
      ["tu_1", { display: "done", displayHeader: "running long script" }],
    ])
    const sink = new CaptureSink()
    await replayToScrollback(messages, sink, { toolDisplays })
    const plain = stripAnsi(sink.out)
    expect(plain).toContain("running long script")
    // No `↳` continuation marker when the plugin owns the header.
    expect(plain).not.toContain("↳")
  })
})

describe("toolDisplaysFromRecords", () => {
  it("returns a map keyed by tool_use_id with every present display field", () => {
    const t = "2026-05-22T17:00:00.000Z"
    const records: SessionRecord[] = [
      {
        kind: "tool_result",
        ts: t,
        tool_use_id: "tu_edit",
        content: "File edited: /x (1)",
        isError: false,
        display: "--- a\n+++ b\n-old\n+new",
      },
      {
        kind: "tool_result",
        ts: t,
        tool_use_id: "tu_task",
        content: '{"action":"done"}',
        isError: false,
        display: "task tree body",
        displayHeader: "✔ ALL DONE · 39/39",
      },
      {
        kind: "tool_result",
        ts: t,
        tool_use_id: "tu_q",
        content: "raw",
        isError: false,
        display: "render",
        displayFooter: "footer · 1ms",
      },
    ]
    const map = toolDisplaysFromRecords(records)
    expect(map.size).toBe(3)
    expect(map.get("tu_edit")?.display).toContain("--- a")
    expect(map.get("tu_task")?.displayHeader).toBe("✔ ALL DONE · 39/39")
    expect(map.get("tu_q")?.displayFooter).toBe("footer · 1ms")
  })

  it("returns an empty map when no overrides AND no matching assistant tool_use rows exist", () => {
    // No tool_use records means the fallback can't look up tool names,
    // so even derivable tools (Task/Edit/Write) get skipped. This pins
    // the "no presentation context anywhere" invariant.
    const t = "2026-05-22T17:00:00.000Z"
    const records: SessionRecord[] = [
      { kind: "tool_result", ts: t, tool_use_id: "tu_1", content: "ok", isError: false },
      { kind: "tool_result", ts: t, tool_use_id: "tu_2", content: "ok", isError: false },
    ]
    const map = toolDisplaysFromRecords(records)
    expect(map.size).toBe(0)
  })

  // Regression for "old session resume still looks bad": even without
  // persisted display fields, the deriver fallback picks up Task / Edit
  // / Write rows by looking at the matching `tool_use` block's name +
  // input. This is what makes pre-fix sessions render the rich body
  // after the fix lands.
  it("derives Task display from content when no fields persisted (pre-fix session)", () => {
    const t = "2026-05-22T17:00:00.000Z"
    const records: SessionRecord[] = [
      {
        kind: "assistant",
        ts: t,
        content: [
          {
            type: "tool_use",
            id: "tu_task",
            name: "Task",
            input: { action: "done", id: "#abc" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        kind: "tool_result",
        ts: t,
        tool_use_id: "tu_task",
        content: ["✔ ALL DONE · 3/3 · ts", "  1  ✔  #a  one", " 3 done · 0 doing · 0 todo"].join(
          "\n",
        ),
        isError: false,
      },
    ]
    const map = toolDisplaysFromRecords(records)
    const entry = map.get("tu_task")
    expect(entry).toBeDefined()
    expect(entry?.displayHeader).toBe("✔ ALL DONE · 3/3 · ts")
    expect(entry?.displayFooter).toBe(" 3 done · 0 doing · 0 todo")
    expect(entry?.display).toBe("  1  ✔  #a  one")
  })

  it("derives Edit display from old_string/new_string when no display persisted", () => {
    const t = "2026-05-22T17:00:00.000Z"
    const records: SessionRecord[] = [
      {
        kind: "assistant",
        ts: t,
        content: [
          {
            type: "tool_use",
            id: "tu_edit",
            name: "Edit",
            input: { file_path: "/abs/x.json", old_string: "old line", new_string: "new line" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        kind: "tool_result",
        ts: t,
        tool_use_id: "tu_edit",
        content: "File edited: /abs/x.json (1 replacement(s))",
        isError: false,
      },
    ]
    const map = toolDisplaysFromRecords(records)
    const entry = map.get("tu_edit")
    expect(entry?.display).toBeDefined()
    const plain = stripAnsi(entry!.display!)
    expect(plain).toContain("--- a//abs/x.json")
    expect(plain).toContain("-old line")
    expect(plain).toContain("+new line")
  })

  it("derives Write display as a new-file diff when no display persisted", () => {
    const t = "2026-05-22T17:00:00.000Z"
    const records: SessionRecord[] = [
      {
        kind: "assistant",
        ts: t,
        content: [
          {
            type: "tool_use",
            id: "tu_w",
            name: "Write",
            input: { file_path: "/abs/new.md", content: "# Hello\n\nworld" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        kind: "tool_result",
        ts: t,
        tool_use_id: "tu_w",
        content: "File written: /abs/new.md",
        isError: false,
      },
    ]
    const map = toolDisplaysFromRecords(records)
    const entry = map.get("tu_w")
    expect(entry?.display).toBeDefined()
    const plain = stripAnsi(entry!.display!)
    expect(plain).toContain("New file: /abs/new.md")
    expect(plain).toContain("+# Hello")
    expect(plain).toContain("+world")
  })

  it("does NOT derive a display when the tool_result is_error (preserve the error text)", () => {
    const t = "2026-05-22T17:00:00.000Z"
    const records: SessionRecord[] = [
      {
        kind: "assistant",
        ts: t,
        content: [
          {
            type: "tool_use",
            id: "tu_e",
            name: "Edit",
            input: { file_path: "/x", old_string: "a", new_string: "b" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        kind: "tool_result",
        ts: t,
        tool_use_id: "tu_e",
        content: "Edit error: old_string not found",
        isError: true,
      },
    ]
    const map = toolDisplaysFromRecords(records)
    expect(map.has("tu_e")).toBe(false)
  })

  it("persisted overrides win over the deriver (idempotent re-runs preserve live data)", () => {
    // If a session has BOTH persisted display fields AND would otherwise
    // be derivable (new sessions running re-resumes), the persisted
    // values must take precedence : the live agent is the source of
    // truth, the deriver is best-effort fallback.
    const t = "2026-05-22T17:00:00.000Z"
    const records: SessionRecord[] = [
      {
        kind: "assistant",
        ts: t,
        content: [
          {
            type: "tool_use",
            id: "tu_t",
            name: "Task",
            input: { action: "add_many", titles: ["x"] },
          },
        ],
        stopReason: "tool_use",
      },
      {
        kind: "tool_result",
        ts: t,
        tool_use_id: "tu_t",
        content: "deriver would split THIS",
        isError: false,
        display: "AUTHORITATIVE BODY",
        displayHeader: "AUTHORITATIVE HEADER",
        displayFooter: "AUTHORITATIVE FOOTER",
      },
    ]
    const map = toolDisplaysFromRecords(records)
    const entry = map.get("tu_t")
    expect(entry?.display).toBe("AUTHORITATIVE BODY")
    expect(entry?.displayHeader).toBe("AUTHORITATIVE HEADER")
    expect(entry?.displayFooter).toBe("AUTHORITATIVE FOOTER")
  })

  it("partial persistence still wins entirely (no per-field merge with deriver)", () => {
    // A row that persisted ONLY displayHeader does NOT also pick up a
    // deriver-supplied display. Per-field merging is intentionally
    // avoided : it would produce inconsistent results (mixing styles
    // from two sources) and the design contract is "persisted row =
    // live agent owned this render".
    const t = "2026-05-22T17:00:00.000Z"
    const records: SessionRecord[] = [
      {
        kind: "assistant",
        ts: t,
        content: [
          {
            type: "tool_use",
            id: "tu_p",
            name: "Task",
            input: { action: "done", id: "#a" },
          },
        ],
        stopReason: "tool_use",
      },
      {
        kind: "tool_result",
        ts: t,
        tool_use_id: "tu_p",
        content: "header line\nbody line\nfooter line",
        isError: false,
        displayHeader: "PERSISTED ONLY THIS",
      },
    ]
    const map = toolDisplaysFromRecords(records)
    const entry = map.get("tu_p")
    expect(entry?.displayHeader).toBe("PERSISTED ONLY THIS")
    expect(entry?.display).toBeUndefined()
    expect(entry?.displayFooter).toBeUndefined()
  })

  it("ignores non-tool_result records", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "2026-05-22T17:00:00.000Z", content: "hi", id: "u1" },
      { kind: "assistant", ts: "2026-05-22T17:00:01.000Z", content: [], stopReason: "end_turn" },
      { kind: "note", ts: "2026-05-22T17:00:02.000Z", text: "n" },
    ]
    const map = toolDisplaysFromRecords(records)
    expect(map.size).toBe(0)
  })

  it("returns the last entry's overrides when the same tool_use_id appears twice (defensive)", () => {
    // Not expected in practice (tool_result records are append-only and
    // tool_use_ids are unique), but we should still survive the case
    // without throwing or returning a stale value.
    const t = "2026-05-22T17:00:00.000Z"
    const records: SessionRecord[] = [
      {
        kind: "tool_result",
        ts: t,
        tool_use_id: "tu_dup",
        content: "first",
        isError: false,
        display: "first display",
      },
      {
        kind: "tool_result",
        ts: t,
        tool_use_id: "tu_dup",
        content: "second",
        isError: false,
        display: "second display",
      },
    ]
    const map = toolDisplaysFromRecords(records)
    expect(map.get("tu_dup")?.display).toBe("second display")
  })
})

describe("userTimestampsFromRecords", () => {
  it("returns one entry per produced message, parallel to foldRecords", () => {
    const t1 = "2026-05-22T17:00:00.000Z"
    const t2 = "2026-05-22T17:00:01.000Z"
    const t3 = "2026-05-22T17:00:02.000Z"
    const records: SessionRecord[] = [
      {
        kind: "meta",
        formatVersion: 1,
        sid: "x",
        createdAt: t1,
        model: "m",
        cwd: "/",
        systemHash: "h",
        toolsHash: "h",
        agentVersion: "v",
      },
      { kind: "user", ts: t1, content: "hi", id: "u1" },
      {
        kind: "assistant",
        ts: t2,
        content: [{ type: "text", text: "hello" }],
        stopReason: "end_turn",
      },
      { kind: "user", ts: t3, content: "more", id: "u2" },
    ]
    const out = userTimestampsFromRecords(records)
    expect(out).toHaveLength(3) // 1 user + 1 assistant + 1 user
    expect(out[0]).toEqual(new Date(t1))
    expect(out[1]).toEqual(new Date(t2))
    expect(out[2]).toEqual(new Date(t3))
  })

  it("appends tool_result to the prior tool_result-user message (no new index)", () => {
    const t1 = "2026-05-22T17:00:00.000Z"
    const t2 = "2026-05-22T17:00:01.000Z"
    const t3 = "2026-05-22T17:00:02.000Z"
    const records: SessionRecord[] = [
      { kind: "user", ts: t1, content: "hi", id: "u1" },
      { kind: "assistant", ts: t2, content: [], stopReason: "end_turn" },
      // First tool_result starts a new synthetic user message…
      { kind: "tool_result", ts: t3, tool_use_id: "tu_1", content: "ok", isError: false },
      // …and a second tool_result APPENDS to it, no new entry.
      { kind: "tool_result", ts: t3, tool_use_id: "tu_2", content: "ok", isError: false },
    ]
    const out = userTimestampsFromRecords(records)
    expect(out).toHaveLength(3) // user + assistant + synthetic tool user
    expect(out[2]).toEqual(new Date(t3))
  })

  it("truncates the array on rewind to the matching user-record offset", () => {
    const t = (s: number) => `2026-05-22T17:00:0${s}.000Z`
    const records: SessionRecord[] = [
      { kind: "user", ts: t(0), content: "hi", id: "u1" },
      { kind: "assistant", ts: t(1), content: [], stopReason: "end_turn" },
      { kind: "user", ts: t(2), content: "follow up", id: "u2" },
      { kind: "assistant", ts: t(3), content: [], stopReason: "end_turn" },
      // Rewind to u1: keep [u1] only, drop everything after.
      { kind: "rewind", ts: t(4), to: "u1", droppedCount: 2 },
    ]
    const out = userTimestampsFromRecords(records)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(new Date(t(0)))
  })

  it("returns null for unparseable timestamps but keeps the index slot", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "not-a-date", content: "hi", id: "u1" },
      { kind: "assistant", ts: "2026-05-22T17:00:01.000Z", content: [], stopReason: "end_turn" },
    ]
    const out = userTimestampsFromRecords(records)
    expect(out).toHaveLength(2)
    expect(out[0]).toBeNull()
    expect(out[1]).toEqual(new Date("2026-05-22T17:00:01.000Z"))
  })

  it("skips meta and note records (they produce no message)", () => {
    const records: SessionRecord[] = [
      {
        kind: "meta",
        formatVersion: 1,
        sid: "x",
        createdAt: "t",
        model: "m",
        cwd: "/",
        systemHash: "h",
        toolsHash: "h",
        agentVersion: "v",
      },
      { kind: "note", ts: "2026-05-22T17:00:00.000Z", text: "n" },
      { kind: "user", ts: "2026-05-22T17:00:01.000Z", content: "hi", id: "u1" },
    ]
    const out = userTimestampsFromRecords(records)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(new Date("2026-05-22T17:00:01.000Z"))
  })
})

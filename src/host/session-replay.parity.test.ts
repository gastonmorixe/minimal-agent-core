import { describe, expect, it } from "bun:test"

import type { Message } from "../client/types.ts"
import { replayToScrollback } from "./session-replay.ts"

class CaptureSink {
  out = ""
  write(s: string): void {
    this.out += s
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

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
        content: [{ type: "tool_use", id: "tu_q", name: "WebSearch", input: { query: "topic" } }],
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

import { describe, expect, it } from "bun:test"

import { toolDisplaysFromRecords, userTimestampsFromRecords } from "./session-replay.ts"
import type { SessionRecord } from "./session-store.ts"

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

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

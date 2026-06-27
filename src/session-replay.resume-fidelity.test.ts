/**
 * End-to-end regression: live transcript → on-disk JSONL → --resume
 * replay MUST recreate the exact body the user saw live, for tools
 * that supply a presentation override (`display` / `displayHeader` /
 * `displayFooter`).
 *
 * Before the fix (snapshots in `tmp/tool-*-rendering-bug-on-resume-*`),
 * three rendering channels regressed on resume:
 *
 *   1. The `╭` header lost its icon (`» Bash`, `✦ Edit`, `✔ Task`)
 *      and its label color, falling back to bold orange.
 *   2. The Edit body lost its unified diff, falling back to the
 *      model-facing `"File edited: ..."` text.
 *   3. The Task body lost its rich tree, AND the header showed the
 *      raw JSON args (`{"action":"done","id":"#56b7b5"}`) instead of
 *      the plugin-rendered summary (`✔ ALL DONE · 39/39 · ...`).
 *
 * This driver runs an end-to-end loop for case 2 (the simplest to
 * exercise without spinning up the full plugin loader): drives a real
 * Edit through `Agent` → SessionStore → loadSession →
 * replayToScrollback, and asserts the diff body survives. Cases 1 and
 * 3 are unit-covered in `session-replay.test.ts` (see the
 * "tool presentation parity" and "display / displayHeader /
 * displayFooter parity" suites).
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { StreamedResponse } from "./client/types.ts"
import { replayToScrollback, toolDisplaysFromRecords } from "./session-replay.ts"
import { loadSession } from "./session-restore.ts"
import { SessionStore } from "./session-store.ts"
import { TOOL_DEFINITIONS } from "./tools.ts"

const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

class CaptureSink {
  out = ""
  write(s: string): void {
    this.out += s
  }
}

/**
 * Build a `sendFn` that emits one Edit tool round, then a trivial
 * end-turn. Drives the real `executeTool` path so the Edit handler
 * computes the actual unified diff and the agent persists it as
 * `display` on the tool_result record.
 */
function singleEditRoundSendFn(filePath: string): import("./llm/transport/types.ts").TransportFn {
  let round = 0
  return async function* (): AsyncGenerator<unknown, StreamedResponse> {
    if (round === 0) {
      round++
      yield ""
      return {
        blocks: [
          {
            type: "tool_use" as const,
            id: "toolu_edit_e2e",
            name: "Edit",
            input: {
              file_path: filePath,
              old_string: "OLD",
              new_string: "NEW",
            },
          },
        ],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    yield "done"
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    } as StreamedResponse
    // biome-ignore lint/suspicious/noExplicitAny: test seam
  } as any as import("./llm/transport/types.ts").TransportFn
}

describe("--resume fidelity: tool display payload survives the JSONL round-trip", () => {
  it("Edit's unified diff body renders on resume (was: 'File edited: ...' regression)", async () => {
    // 1. Run a real Edit through Agent, persisting to a fresh session file.
    const sandbox = tmp("ma-resume-edit-")
    const sessionDir = tmp("ma-resume-sess-")
    const target = join(sandbox, "config.json")
    writeFileSync(target, "before\nOLD\nafter\n", "utf-8")

    const store = SessionStore.open({
      sid: "ma-edit-e2e",
      dir: sessionDir,
      model: "test-model",
      cwd: sandbox,
      systemHash: "h",
      toolsHash: "h",
      agentVersion: "test",
    })
    const agent = new Agent({
      auth: { type: "api-key", token: "test-token" },
      model: "test-model",
      sendFn: singleEditRoundSendFn(target),
      store,
    })
    for await (const _ of agent.run("change OLD to NEW")) {
      // drain
    }

    // 2. Read the JSONL back via `loadSession`, build the sidecar map,
    //    and replay to a capture sink.
    const loaded = loadSession("ma-edit-e2e", sessionDir)
    const toolDisplays = toolDisplaysFromRecords(loaded.records)
    expect(toolDisplays.size).toBe(1)
    expect(toolDisplays.get("toolu_edit_e2e")?.display).toBeTypeOf("string")

    const presentation = new Map<string, { icon?: string; color?: string }>()
    for (const t of TOOL_DEFINITIONS) {
      if (t.icon || t.color) presentation.set(t.name, { icon: t.icon, color: t.color })
    }
    const sink = new CaptureSink()
    await replayToScrollback(loaded.messages, sink, {
      toolDisplays,
      toolPresentation: presentation,
    })

    const plain = stripAnsi(sink.out)

    // 3. The replayed body MUST carry the diff hunk markers, not the
    //    model-facing summary text. This is the regression-defining
    //    assertion : pre-fix this would have been "File edited: ..."
    //    on a single body line.
    expect(plain).toContain("@@")
    expect(plain).toContain("-OLD")
    expect(plain).toContain("+NEW")
    expect(plain).not.toMatch(/^\s*│\s+File edited:/m)

    // 4. The header must carry the Edit icon (`✦`) + tool name.
    expect(plain).toMatch(/╭ ✦ Edit/)
  })

  it("old session files (no `display` persisted) replay with the original content fallback", () => {
    // Backwards compatibility: a JSONL file produced before this fix
    // has tool_result records with `content` only. For Bash (no
    // deriver), `toolDisplaysFromRecords` must return an empty map AND
    // the replay path must fall back to `content`. Tests the "old file
    // → new agent" path for tools without a deriver.
    const sessionDir = tmp("ma-resume-old-")
    const sid = "ma-old"
    const path = join(sessionDir, `${sid}.jsonl`)
    const ts = "2026-05-22T17:00:00.000Z"
    const lines = [
      JSON.stringify({
        kind: "meta",
        formatVersion: 1,
        sid,
        createdAt: ts,
        model: "m",
        cwd: "/",
        systemHash: "h",
        toolsHash: "h",
        agentVersion: "v",
      }),
      JSON.stringify({ kind: "user", ts, content: "hi", id: "u1" }),
      JSON.stringify({
        kind: "assistant",
        ts,
        content: [{ type: "tool_use", id: "tu_legacy", name: "Bash", input: { command: "ls" } }],
        stopReason: "tool_use",
      }),
      JSON.stringify({
        kind: "tool_result",
        ts,
        tool_use_id: "tu_legacy",
        content: "a.txt\nb.txt",
        isError: false,
      }),
    ]
    writeFileSync(path, `${lines.join("\n")}\n`, "utf-8")

    const loaded = loadSession(sid, sessionDir)
    const map = toolDisplaysFromRecords(loaded.records)
    // Bash has no deriver → empty map → replay falls back to `content`.
    expect(map.size).toBe(0)
    expect(loaded.messages.length).toBeGreaterThan(0)
  })

  it("PRE-FIX session with a Task call: deriver reconstructs the rich render on resume", async () => {
    // This is the user-reported regression for session 41200730-... :
    // a JSONL written before display fields were persisted, but the
    // model-facing `content` carries the full `header\nbody\nfooter`
    // text. The deriver should produce the displayHeader / displayFooter
    // so replay renders the rich Task block instead of "shown 10/13 L"
    // truncation.
    const sessionDir = tmp("ma-resume-task-old-")
    const sid = "ma-task-old"
    const path = join(sessionDir, `${sid}.jsonl`)
    const ts = "2026-05-22T17:00:00.000Z"
    const taskContent = [
      "✔ ALL DONE · 3/3 · 2026-05-28 08:29:05",
      "   1  ✔  #aaa  First step  3m 46s",
      "   2  ✔  #bbb  Second step  9m 02s",
      "   3  ✔  #ccc  Third step  10m 26s",
      " ✦ ALL DONE · 3 done · 23m 14s",
    ].join("\n")
    const lines = [
      JSON.stringify({
        kind: "meta",
        formatVersion: 1,
        sid,
        createdAt: ts,
        model: "m",
        cwd: "/",
        systemHash: "h",
        toolsHash: "h",
        agentVersion: "v",
      }),
      JSON.stringify({ kind: "user", ts, content: "wrap up", id: "u1" }),
      JSON.stringify({
        kind: "assistant",
        ts,
        content: [
          {
            type: "tool_use",
            id: "tu_task_old",
            name: "Task",
            input: { action: "done", id: "#ccc" },
          },
        ],
        stopReason: "tool_use",
      }),
      // NOTE: no `display` / `displayHeader` / `displayFooter` keys.
      JSON.stringify({
        kind: "tool_result",
        ts,
        tool_use_id: "tu_task_old",
        content: taskContent,
        isError: false,
      }),
    ]
    writeFileSync(path, `${lines.join("\n")}\n`, "utf-8")

    const loaded = loadSession(sid, sessionDir)
    const toolDisplays = toolDisplaysFromRecords(loaded.records)

    const derived = toolDisplays.get("tu_task_old")
    expect(derived?.displayHeader).toBe("✔ ALL DONE · 3/3 · 2026-05-28 08:29:05")
    expect(derived?.displayFooter).toBe(" ✦ ALL DONE · 3 done · 23m 14s")
    expect(derived?.display).toBe(
      [
        "   1  ✔  #aaa  First step  3m 46s",
        "   2  ✔  #bbb  Second step  9m 02s",
        "   3  ✔  #ccc  Third step  10m 26s",
      ].join("\n"),
    )

    const sink = new CaptureSink()
    await replayToScrollback(loaded.messages, sink, {
      toolDisplays,
      toolPresentation: new Map([["Task", { icon: "✔", color: "lime" }]]),
    })
    const plain = stripAnsi(sink.out)
    expect(plain).toMatch(/╭ ✔ Task\s+✔ ALL DONE · 3\/3/)
    expect(plain).toContain("First step")
    expect(plain).toContain("Third step")
    expect(plain).toMatch(/╰\s+✦ ALL DONE · 3 done · 23m 14s/)
    // Regressions we explicitly DON'T want.
    expect(plain).not.toMatch(/╭ ✔ Task\s+\{"action":"done"/)
    expect(plain).not.toMatch(/shown \d+\/\d+ L/)
  })

  it("PRE-FIX session with an Edit call: deriver reconstructs the diff on resume", async () => {
    const sessionDir = tmp("ma-resume-edit-old-")
    const sid = "ma-edit-old"
    const path = join(sessionDir, `${sid}.jsonl`)
    const ts = "2026-05-22T17:00:00.000Z"
    const lines = [
      JSON.stringify({
        kind: "meta",
        formatVersion: 1,
        sid,
        createdAt: ts,
        model: "m",
        cwd: "/",
        systemHash: "h",
        toolsHash: "h",
        agentVersion: "v",
      }),
      JSON.stringify({ kind: "user", ts, content: "edit", id: "u1" }),
      JSON.stringify({
        kind: "assistant",
        ts,
        content: [
          {
            type: "tool_use",
            id: "tu_edit_old",
            name: "Edit",
            input: {
              file_path: "/abs/config.json",
              old_string: '"port": 8080',
              new_string: '"port": 9090',
            },
          },
        ],
        stopReason: "tool_use",
      }),
      JSON.stringify({
        kind: "tool_result",
        ts,
        tool_use_id: "tu_edit_old",
        content: "File edited: /abs/config.json (1 replacement(s))",
        isError: false,
      }),
    ]
    writeFileSync(path, `${lines.join("\n")}\n`, "utf-8")
    const loaded = loadSession(sid, sessionDir)
    const toolDisplays = toolDisplaysFromRecords(loaded.records)
    expect(toolDisplays.has("tu_edit_old")).toBe(true)
    const sink = new CaptureSink()
    await replayToScrollback(loaded.messages, sink, {
      toolDisplays,
      toolPresentation: new Map([["Edit", { icon: "✦", color: "gold" }]]),
    })
    const plain = stripAnsi(sink.out)
    expect(plain).toMatch(/╭ ✦ Edit/)
    expect(plain).toContain('-"port": 8080')
    expect(plain).toContain('+"port": 9090')
    // The model-facing "File edited:" text must NOT render in the body.
    expect(plain).not.toMatch(/^\s*│\s+File edited:/m)
  })
})

/**
 * Old session records with presentation fields still restore (spec S29,
 * D18). Records written before S29 can hold pre-rendered `display`,
 * `displayHeader`, and `displayFooter` strings on a `tool_result`. Core
 * ignores them: the restored history is the same as for a record without
 * them, and no field reaches the model. New writes never add them.
 *
 * @module session/restore-legacy.test
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { executeToolRound } from "../agent/tool-round.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { loadSessionFromText } from "./session-restore.ts"
import { SessionStore } from "./session-store.ts"

const FIXTURE = join(import.meta.dirname, "fixtures", "legacy-display-session.jsonl")
const PRESENTATION_KEYS = ["display", "displayHeader", "displayFooter"] as const

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** The same records with every presentation field taken out. */
function withoutPresentation(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length === 0) return line
      const rec = JSON.parse(line) as Record<string, unknown>
      for (const key of PRESENTATION_KEYS) delete rec[key]
      return JSON.stringify(rec)
    })
    .join("\n")
}

describe("restore of an old session with presentation fields (S29)", () => {
  const legacy = readFileSync(FIXTURE, "utf8")

  it("uses a fixture that really holds the old fields", () => {
    for (const key of PRESENTATION_KEYS) expect(legacy).toContain(`"${key}"`)
  })

  it("restores without error and drops no record", () => {
    const loaded = loadSessionFromText(legacy)
    expect(loaded.dropped).toEqual([])
    expect(loaded.meta?.sid).toBe("legacy-display")
    expect(loaded.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
  })

  it("gives the same model and display history as a record without the fields", () => {
    const loaded = loadSessionFromText(legacy)
    const clean = loadSessionFromText(withoutPresentation(legacy))
    expect(loaded.messages).toEqual(clean.messages)
    expect(loaded.displayMessages).toEqual(clean.displayMessages)
  })

  it("sends no presentation field or escape byte to the model", () => {
    const history = JSON.stringify(loadSessionFromText(legacy).messages)
    for (const key of PRESENTATION_KEYS) expect(history).not.toContain(`"${key}"`)
    expect(history).not.toContain("\\u001b")
    expect(history).toContain("File edited: /work/a.txt (1 replacement(s))")
  })

  it("keeps the old fields on the parsed record for a host replay", () => {
    const loaded = loadSessionFromText(legacy)
    const task = loaded.records.find((r) => r.kind === "tool_result" && r.tool_use_id === "tu_task")
    expect(task && "displayFooter" in task ? task.displayFooter : null).toBe("0/1 done")
  })

  it("new writes skip the fields, also for an Edit diff from the tool round", async () => {
    const dir = mkdtempSync(join(tmpdir(), "core-restore-legacy-"))
    dirs.push(dir)
    const store = SessionStore.open({
      sid: "legacy-display-new",
      dir,
      model: "test-model",
      cwd: "/work",
      systemHash: "s",
      toolsHash: "t",
      agentVersion: "test",
    })
    store.appendToolResult({
      type: "tool_result",
      tool_use_id: "tu_new",
      content: "File edited: /work/a.txt (1 replacement(s))",
      is_error: false,
    })
    // Before S29 the tool round stored the Edit diff as `display`.
    const file = join(dir, "a.txt")
    writeFileSync(file, "a\nb\n")
    await executeToolRound(
      {
        type: "tool_use",
        id: "tu_round",
        name: "Edit",
        input: { file_path: file, old_string: "b", new_string: "B" },
      },
      {
        loader: null,
        modeManager: null,
        blobStore: null,
        blobSkipTools: new Set(),
        feedbackTracker: new ToolFeedbackTracker(),
        model: "test-model",
        store,
      },
    )
    const written = readFileSync(store.path, "utf8")
    expect(written).toContain('"tool_use_id":"tu_round"')
    for (const key of PRESENTATION_KEYS) expect(written).not.toContain(`"${key}"`)
    expect(loadSessionFromText(written).dropped).toEqual([])
  })
})

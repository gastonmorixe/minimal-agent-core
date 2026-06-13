/**
 * End-to-end integration tests for the tasks plugin.
 *
 * Exercises the full closing-the-loop flow WITHOUT importing host code, so
 * the plugin's own suite stays repo-portable (the decoupling contract):
 *
 *   1. The plugin's `manifest.json` declares the `Task` tool (with its icon
 *      and color) and the per-turn `tasks_snapshot` attachment.
 *   2. A `Task({action: "add_many", ...})` is dispatched by invoking the
 *      handler's default export directly → handler appends to disk via
 *      `TaskStore` → returns the rendered list in `tool_result.display`.
 *   3. A fresh `TasksAttachment` for the same session id sees the committed
 *      state, ready to inject on the next user turn.
 *   4. A `Task({action: "done", id: 1})` flips the first task and the
 *      attachment reflects it.
 *
 * The host loader's discovery/dispatch wiring (manifest → module resolve →
 * dispatch) is host-internal and covered by the host's own loader-contract
 * tests; here we cover the plugin's handler + store + attachment seams, which
 * is what must keep working when this directory lives in its own repo.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { TUIContext, TUIResult } from "@minimal-agent/plugin-api/types/plugin"

import taskToolHandler from "./handlers/task_tool.ts"
import { TasksAttachment } from "./lib/attachment.ts"
import { TaskStore } from "./lib/store.ts"

const MANIFEST = JSON.parse(readFileSync(join(import.meta.dir, "manifest.json"), "utf-8")) as {
  tuis: { trigger: { tool?: { name?: string } }; icon?: string; color?: string }[]
  turnAttachments?: { id: string }[]
}

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "tasks-integration-"))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

/** A minimal TUIContext good enough to dispatch the Task tool handler. */
function ctx(sid: string, input: Record<string, unknown>): TUIContext {
  return {
    trigger: { type: "tool", name: "Task", input, tool_use_id: "tu" },
    packageDir: "/tmp/fake-package-dir",
    cwd: "/tmp/fake-cwd",
    env: { HOME: tmpHome, MINIMAL_AGENT_SESSION_ID: sid },
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
  } as unknown as TUIContext
}

type ToolResult = Extract<TUIResult, { kind: "tool_result" }>

async function dispatch(sid: string, input: Record<string, unknown>): Promise<ToolResult> {
  const r = await taskToolHandler(ctx(sid, input))
  if (r.kind !== "tool_result") throw new Error(`expected tool_result, got ${r.kind}`)
  return r
}

describe("tasks plugin — full handler → store → attachment loop", () => {
  it("manifest declares the Task tool and the tasks snapshot attachment", () => {
    const task = MANIFEST.tuis.find((t) => t.trigger.tool?.name === "Task")
    expect(task).toBeDefined()
    // The cosmetic icon + color flow into the host tool frame (toolPresentation).
    expect(task?.icon).toBe("✔")
    expect(task?.color).toBe("lime")
    expect(MANIFEST.turnAttachments?.some((a) => a.id === "tasks_snapshot")).toBe(true)
  })

  it("add_many → store on disk → attachment reflects it", async () => {
    const sid = "11111111-aaaa-bbbb-cccc-dddddddddddd"

    // --- Dispatch add_many through the handler ---
    const addResult = await dispatch(sid, {
      action: "add_many",
      titles: ["plan step 1", "plan step 2", "plan step 3"],
    })
    expect(addResult.is_error).toBeFalsy()
    expect(addResult.displayHeader).toContain("added 3 tasks")
    expect(addResult.content).toContain("plan step 1")
    expect(addResult.content).toContain("plan step 3")

    // --- File on disk has the tasks ---
    const store = new TaskStore(sid, { home: tmpHome })
    const tasks = store.list()
    expect(tasks).toHaveLength(3)
    expect(tasks.map((t) => t.title)).toEqual(["plan step 1", "plan step 2", "plan step 3"])

    // --- A fresh TasksAttachment sees the committed state ---
    const att = new TasksAttachment(sid, { home: tmpHome })
    const text = att.toText()
    expect(text).not.toBeNull()
    expect(text!).toContain("<ma::agent::tasks")
    expect(text!).toContain(`total="3"`)
    expect(text!).toContain("plan step 1")
  })

  it("done flips a task and the attachment reflects the new status", async () => {
    const sid = "22222222-aaaa-bbbb-cccc-dddddddddddd"

    await dispatch(sid, { action: "add_many", titles: ["first", "second"] })

    const doneResult = await dispatch(sid, { action: "done", id: 1 })
    expect(doneResult.is_error).toBeFalsy()
    expect(doneResult.displayHeader).toContain("marked done")

    // Attachment sees done=1, todo=1.
    const text = new TasksAttachment(sid, { home: tmpHome }).toText()!
    expect(text).toContain(`done="1"`)
    expect(text).toContain(`todo="1"`)
    expect(text).toContain("done")
  })

  it("all-done verb fires when the LAST top-level task is completed", async () => {
    const sid = "33333333-aaaa-bbbb-cccc-dddddddddddd"

    await dispatch(sid, { action: "add", title: "the only task" })
    const r = await dispatch(sid, { action: "done", id: 1 })
    expect(r.displayHeader).toContain("ALL DONE")
  })

  it("subtasks: add child via #parent and the attachment shows the tree", async () => {
    const sid = "44444444-aaaa-bbbb-cccc-dddddddddddd"

    const parentR = await dispatch(sid, { action: "add", title: "parent" })
    const m = /#([0-9a-f]{6})/.exec(parentR.content!)
    expect(m).not.toBeNull()
    const parentHash = m![1]

    await dispatch(sid, { action: "add", title: "child A", parent: `#${parentHash}` })
    await dispatch(sid, { action: "add", title: "child B", parent: `#${parentHash}` })

    const text = new TasksAttachment(sid, { home: tmpHome }).toText()!
    // Subtask positions are 1a, 1b — pinned by the attachment renderer.
    expect(text).toContain("1a")
    expect(text).toContain("1b")
    expect(text).toContain(`#${parentHash}a`)
    expect(text).toContain(`#${parentHash}b`)
    expect(text).toContain("child A")
    expect(text).toContain("child B")
  })

  it("clear refuses with a doing task; force overrides", async () => {
    const sid = "55555555-aaaa-bbbb-cccc-dddddddddddd"

    await dispatch(sid, { action: "add", title: "x" })
    await dispatch(sid, { action: "start", id: 1 })

    const refused = await dispatch(sid, { action: "clear" })
    expect(refused.is_error).toBe(true)
    expect(refused.content).toMatch(/refusing to clear/)

    const forced = await dispatch(sid, { action: "clear", force: true })
    expect(forced.is_error).toBeFalsy()

    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()).toEqual([])
  })
})

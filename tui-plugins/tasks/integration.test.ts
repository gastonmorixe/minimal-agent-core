/**
 * End-to-end integration tests for the tasks plugin.
 *
 * Exercises the full closing-the-loop flow:
 *
 *   1. Real `PluginLoader` discovers and loads the embedded tasks plugin.
 *   2. A `Task({action: "add_many", ...})` tool_use is dispatched through
 *      the loader → handler appends to disk via `TaskStore` → returns
 *      the rendered list in `tool_result.display`.
 *   3. A fresh `TasksAttachment` for the same session id sees the
 *      committed state, ready to inject on the next user turn.
 *   4. A `Task({action: "done", id: 1})` dispatched through the loader
 *      flips the first task and the attachment reflects it.
 *
 * If any seam breaks (manifest validation, handler module load, store
 * write/read, attachment file read), this test catches it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { PluginLoader } from "../../src/plugins/loader.ts"

import { TasksAttachment } from "./lib/attachment.ts"
import { TaskStore } from "./lib/store.ts"

const PROJECT_ROOT = resolve(__dirname, "../..")

let tmpHome: string
let savedHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "tasks-integration-"))
  savedHome = process.env.HOME
  process.env.HOME = tmpHome
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe("tasks plugin — full loader → handler → attachment loop", () => {
  it("add_many → store on disk → attachment reflects it", async () => {
    const sid = "11111111-aaaa-bbbb-cccc-dddddddddddd"
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })

    // --- 1. Loader discovered the Task tool ---
    const tools = loader.getExtraTools()
    const task = tools.find((t) => t.name === "Task")
    expect(task).toBeDefined()
    expect(task!.description).toContain("task")

    // --- 2. Dispatch add_many via the loader ---
    const addResult = await loader.dispatch(
      {
        type: "tool",
        name: "Task",
        input: {
          action: "add_many",
          titles: ["plan step 1", "plan step 2", "plan step 3"],
        },
        tool_use_id: "tu-add",
      },
      process.cwd(),
    )
    expect(addResult).not.toBeNull()
    if (addResult?.kind !== "tool_result") return
    expect(addResult.is_error).toBeFalsy()
    expect(addResult.displayHeader).toContain("added 3 tasks")
    expect(addResult.content).toContain("plan step 1")
    expect(addResult.content).toContain("plan step 3")

    // --- 3. File on disk has the tasks ---
    const store = new TaskStore(sid, { home: tmpHome })
    const tasks = store.list()
    expect(tasks).toHaveLength(3)
    expect(tasks.map((t) => t.title)).toEqual(["plan step 1", "plan step 2", "plan step 3"])

    // --- 4. A fresh TasksAttachment sees the committed state ---
    const att = new TasksAttachment(sid, { home: tmpHome })
    const text = att.toText()
    expect(text).not.toBeNull()
    expect(text!).toContain("<ma::tui::tasks")
    expect(text!).toContain(`total="3"`)
    expect(text!).toContain("plan step 1")
  })

  it("done flips a task and the attachment reflects the new status", async () => {
    const sid = "22222222-aaaa-bbbb-cccc-dddddddddddd"
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })

    // Seed two tasks via add_many, then mark #1 done.
    await loader.dispatch(
      {
        type: "tool",
        name: "Task",
        input: { action: "add_many", titles: ["first", "second"] },
        tool_use_id: "tu-add",
      },
      process.cwd(),
    )

    const doneResult = await loader.dispatch(
      {
        type: "tool",
        name: "Task",
        input: { action: "done", id: 1 },
        tool_use_id: "tu-done",
      },
      process.cwd(),
    )
    expect(doneResult).not.toBeNull()
    if (doneResult?.kind !== "tool_result") return
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
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })

    await loader.dispatch(
      {
        type: "tool",
        name: "Task",
        input: { action: "add", title: "the only task" },
        tool_use_id: "tu-add",
      },
      process.cwd(),
    )
    const r = await loader.dispatch(
      {
        type: "tool",
        name: "Task",
        input: { action: "done", id: 1 },
        tool_use_id: "tu-done",
      },
      process.cwd(),
    )
    if (r?.kind !== "tool_result") return
    expect(r.displayHeader).toContain("all done")
  })

  it("subtasks: add child via #parent and the attachment shows the tree", async () => {
    const sid = "44444444-aaaa-bbbb-cccc-dddddddddddd"
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })

    const parentR = await loader.dispatch(
      {
        type: "tool",
        name: "Task",
        input: { action: "add", title: "parent" },
        tool_use_id: "tu-p",
      },
      process.cwd(),
    )
    if (parentR?.kind !== "tool_result") return
    const m = /#([0-9a-f]{6})/.exec(parentR.content!)
    expect(m).not.toBeNull()
    const parentHash = m![1]

    await loader.dispatch(
      {
        type: "tool",
        name: "Task",
        input: { action: "add", title: "child A", parent: `#${parentHash}` },
        tool_use_id: "tu-c1",
      },
      process.cwd(),
    )
    await loader.dispatch(
      {
        type: "tool",
        name: "Task",
        input: { action: "add", title: "child B", parent: `#${parentHash}` },
        tool_use_id: "tu-c2",
      },
      process.cwd(),
    )

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
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })

    await loader.dispatch(
      {
        type: "tool",
        name: "Task",
        input: { action: "add", title: "x" },
        tool_use_id: "tu-add",
      },
      process.cwd(),
    )
    await loader.dispatch(
      {
        type: "tool",
        name: "Task",
        input: { action: "start", id: 1 },
        tool_use_id: "tu-start",
      },
      process.cwd(),
    )

    const refused = await loader.dispatch(
      {
        type: "tool",
        name: "Task",
        input: { action: "clear" },
        tool_use_id: "tu-clear-1",
      },
      process.cwd(),
    )
    if (refused?.kind !== "tool_result") return
    expect(refused.is_error).toBe(true)
    expect(refused.content).toMatch(/refusing to clear/)

    const forced = await loader.dispatch(
      {
        type: "tool",
        name: "Task",
        input: { action: "clear", force: true },
        tool_use_id: "tu-clear-2",
      },
      process.cwd(),
    )
    if (forced?.kind !== "tool_result") return
    expect(forced.is_error).toBeFalsy()

    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()).toEqual([])
  })

  it("renders the Task tool with the manifest's icon and color on the loader's tool list", async () => {
    const sid = "66666666-aaaa-bbbb-cccc-dddddddddddd"
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })
    const task = loader.getExtraTools().find((t) => t.name === "Task")
    expect(task).toBeDefined()
    // The cosmetic icon + color flow into `toolPresentation` in agent.ts.
    // We just verify the manifest fields are carried through to the
    // loader's external tool list — the rendering itself lives in agent.ts.
    expect((task as unknown as { icon?: string }).icon).toBe("✔")
    expect((task as unknown as { color?: string }).color).toBe("lime")
  })
})

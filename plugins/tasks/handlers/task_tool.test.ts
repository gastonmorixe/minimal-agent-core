import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"

import taskToolHandler from "./task_tool.ts"
import { TaskStore } from "../lib/store.ts"

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let tmpHome: string
const sid = "task-tool-test-sid"

function ctx(input: Record<string, unknown>): TUIContext {
  return {
    trigger: { type: "tool", name: "Task", input, tool_use_id: "test_id" },
    packageDir: "/tmp/fake-package-dir",
    cwd: "/tmp/fake-cwd",
    env: { HOME: tmpHome, MINIMAL_AGENT_SESSION_ID: sid },
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
  }
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "tasks-handler-"))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

async function call(input: Record<string, unknown>): Promise<TUIResult> {
  return taskToolHandler(ctx(input))
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validation", () => {
  test("rejects unknown action", async () => {
    const r = await call({ action: "bogus" })
    expect(r.kind).toBe("tool_result")
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/`action` must be one of/)
  })
  test("rejects missing required field", async () => {
    const r = await call({ action: "add" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/`title` is required/)
  })
  test("rejects empty title", async () => {
    const r = await call({ action: "add", title: "   " })
    expect(r.is_error).toBe(true)
  })
  test("rejects non-string id (other than positive int)", async () => {
    const r1 = await call({ action: "done", id: 0 })
    expect(r1.is_error).toBe(true)
    const r2 = await call({ action: "done", id: "" })
    expect(r2.is_error).toBe(true)
  })
  test("rejects empty array for titles or order", async () => {
    const r1 = await call({ action: "add_many", titles: [] })
    expect(r1.is_error).toBe(true)
    const r2 = await call({ action: "reorder", order: [] })
    expect(r2.is_error).toBe(true)
  })
  test("rejects bad status value", async () => {
    const r = await call({ action: "status", id: 1, status: "pending" })
    expect(r.is_error).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Session-id plumbing
// ---------------------------------------------------------------------------

describe("session id", () => {
  test("returns an error when sid is missing", async () => {
    const r = await taskToolHandler({
      ...ctx({ action: "list" }),
      env: { HOME: tmpHome, MINIMAL_AGENT_SESSION_ID: "" },
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/session id/)
  })
})

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe("add", () => {
  test("creates a task and returns the rendered list", async () => {
    const r = await call({ action: "add", title: "hello" })
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("hello")
    expect(r.display).toContain("hello")
    expect(r.displayHeader).toContain("added")
    expect(r.display).not.toContain("╭")
  })
  test("supports parent for subtasks", async () => {
    const r1 = await call({ action: "add", title: "parent" })
    const id = extractFirstHash(r1.content!)
    const r2 = await call({ action: "add", title: "child", parent: `#${id}` })
    expect(r2.is_error).toBeUndefined()
    expect(r2.content).toContain("child")
    // The new subtask id should be the parent id + alpha suffix.
    expect(r2.content).toMatch(new RegExp(`#${id}a`))
  })
  test("returns error for missing parent", async () => {
    const r = await call({ action: "add", title: "x", parent: "#deadbe" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/parent.*not found/)
  })
  test("supports the after parameter (insert position)", async () => {
    await call({ action: "add", title: "first" })
    await call({ action: "add", title: "second" })
    await call({ action: "add", title: "middle", after: 1 })
    const r = await call({ action: "list" })
    const lines = r.content!.split("\n").filter((l) => l.includes("#"))
    expect(lines[0]).toContain("first")
    expect(lines[1]).toContain("middle")
    expect(lines[2]).toContain("second")
  })
})

// ---------------------------------------------------------------------------
// add_many
// ---------------------------------------------------------------------------

describe("add_many", () => {
  test("creates each task", async () => {
    const r = await call({ action: "add_many", titles: ["one", "two", "three"] })
    expect(r.is_error).toBeUndefined()
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list().map((t) => t.title)).toEqual(["one", "two", "three"])
    expect(r.displayHeader).toContain("added 3 tasks")
  })
  test("supports a shared parent", async () => {
    const r1 = await call({ action: "add", title: "parent" })
    const id = extractFirstHash(r1.content!)
    await call({ action: "add_many", titles: ["c1", "c2"], parent: `#${id}` })
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()).toHaveLength(3)
    expect(store.list()[1].parent).toBe(id)
    expect(store.list()[2].parent).toBe(id)
  })
})

// ---------------------------------------------------------------------------
// status / start / done
// ---------------------------------------------------------------------------

describe("status / start / done", () => {
  test("status sets the new state", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({ action: "status", id: 1, status: "doing" })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("marked doing")
  })
  test("status=canceled records the reason", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({
      action: "status",
      id: 1,
      status: "canceled",
      reason: "user redirected",
    })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("canceled")
    expect(r.display).toContain("user redirected")
  })
  test("start enforces single-doing discipline by default", async () => {
    await call({ action: "add", title: "one" })
    await call({ action: "add", title: "two" })
    await call({ action: "start", id: 1 })
    const r = await call({ action: "start", id: 2 })
    expect(r.is_error).toBeUndefined()
    const store = new TaskStore(sid, { home: tmpHome })
    const doings = store.list().filter((t) => t.status === "doing")
    expect(doings).toHaveLength(1)
    expect(doings[0].title).toBe("two")
  })
  test("start parallel:true allows multiple doings", async () => {
    await call({ action: "add", title: "one" })
    await call({ action: "add", title: "two" })
    await call({ action: "start", id: 1 })
    await call({ action: "start", id: 2, parallel: true })
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list().filter((t) => t.status === "doing")).toHaveLength(2)
  })
  test("done is sugar for status=done", async () => {
    await call({ action: "add", title: "x" })
    // Add a second task so completing #1 doesn't trigger the 'ALL DONE' verb,
    // which has its own dedicated test below.
    await call({ action: "add", title: "y" })
    const r = await call({ action: "done", id: 1 })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("marked done")
  })
  test("done on the LAST remaining task triggers 'ALL DONE' verb", async () => {
    await call({ action: "add", title: "one" })
    await call({ action: "add", title: "two" })
    await call({ action: "done", id: 1 })
    const r = await call({ action: "done", id: 2 })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("ALL DONE")
  })
})

// ---------------------------------------------------------------------------
// update / remove / reorder / clear / list
// ---------------------------------------------------------------------------

describe("update", () => {
  test("changes title and renders the diff (old → new) in the display", async () => {
    await call({ action: "add", title: "before" })
    const r = await call({ action: "update", id: 1, title: "after" })
    expect(r.is_error).toBeUndefined()
    // Both the old and new titles appear, with an arrow between them.
    // The display lets the user SEE what changed instead of silently swapping.
    expect(r.display).toContain("before")
    expect(r.display).toContain("after")
    expect(r.display).toContain("→")
    // The store itself reflects only the post-state (no stale title on disk).
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()[0].title).toBe("after")
  })
  test("no diff overlay when the title is unchanged (avoid 'x → x' noise)", async () => {
    await call({ action: "add", title: "same" })
    const r = await call({ action: "update", id: 1, title: "same" })
    expect(r.is_error).toBeUndefined()
    expect(r.display).toContain("same")
    expect(r.display).not.toContain("→")
  })
  test("error for unknown id", async () => {
    const r = await call({ action: "update", id: "#deadbe", title: "x" })
    expect(r.is_error).toBe(true)
  })
})

describe("remove", () => {
  test("removes the task from disk", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({ action: "remove", id: 1 })
    expect(r.is_error).toBeUndefined()
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()).toEqual([])
  })
  test("keeps a ghost-removed tombstone in the rendered display so the user sees WHAT was removed", async () => {
    await call({ action: "add", title: "alpha" })
    await call({ action: "add", title: "beta" })
    await call({ action: "add", title: "gamma" })
    const r = await call({ action: "remove", id: 2 })
    expect(r.is_error).toBeUndefined()
    // The removed task's title still appears in the display body (tombstone).
    expect(r.display).toContain("beta")
    // The other tasks are still there too.
    expect(r.display).toContain("alpha")
    expect(r.display).toContain("gamma")
    // Closer reflects post-state (2 todo, not 3).
    expect(r.displayFooter).toContain("2 todo")
  })
  test("removing a parent ghosts the whole subtree (cascade)", async () => {
    const parent = await call({ action: "add", title: "parent" })
    const pid = /#([0-9a-f]{6})/.exec(parent.content!)![1]
    await call({ action: "add", title: "child A", parent: `#${pid}` })
    await call({ action: "add", title: "child B", parent: `#${pid}` })
    const r = await call({ action: "remove", id: `#${pid}` })
    expect(r.is_error).toBeUndefined()
    // Parent + both children appear as ghost rows in the display.
    expect(r.display).toContain("parent")
    expect(r.display).toContain("child A")
    expect(r.display).toContain("child B")
    // But the store is empty.
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()).toEqual([])
  })
})

describe("reorder", () => {
  test("rearranges top-level tasks", async () => {
    const r1 = await call({ action: "add", title: "1" })
    const r2 = await call({ action: "add", title: "2" })
    const r3 = await call({ action: "add", title: "3" })
    const id1 = extractFirstHash(r1.content!)
    void r2
    const id3 = extractFirstHash(r3.content!)
    const r = await call({ action: "reorder", order: [`#${id3}`, `#${id1}`] })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("reordered")
  })
})

describe("clear", () => {
  test("wipes all when no doing tasks", async () => {
    await call({ action: "add", title: "x" })
    const r = await call({ action: "clear" })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("cleared")
  })
  test("refuses when a task is doing (no force)", async () => {
    await call({ action: "add", title: "x", status: "doing" })
    const r = await call({ action: "clear" })
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/refusing to clear/)
  })
  test("force: true overrides the refusal", async () => {
    await call({ action: "add", title: "x", status: "doing" })
    const r = await call({ action: "clear", force: true })
    expect(r.is_error).toBeUndefined()
  })
})

describe("list", () => {
  test("renders the current state without mutating", async () => {
    await call({ action: "add", title: "x" })
    const before = new TaskStore(sid, { home: tmpHome }).list()
    const r = await call({ action: "list" })
    expect(r.is_error).toBeUndefined()
    // Header content is action-specific; for `list` with N tasks it
    // includes the count summary. The "Tasks" brand lives on the CLI
    // path only (`renderBlock`); the agent path delegates identity to
    // the manifest's icon/label via host chrome.
    expect(r.displayHeader).toContain("1 task")
    const after = new TaskStore(sid, { home: tmpHome }).list()
    expect(after).toEqual(before)
  })
  test("empty state shows 'no tasks'", async () => {
    const r = await call({ action: "list" })
    expect(r.is_error).toBeUndefined()
    expect(r.displayHeader).toContain("no tasks")
  })
})

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

describe("format: json", () => {
  test("returns parseable JSON in content with rendered ANSI in display", async () => {
    await call({ action: "add", title: "hello" })
    const r = await call({ action: "list", format: "json" })
    expect(r.is_error).toBeUndefined()
    expect(() => JSON.parse(r.content!)).not.toThrow()
    const parsed = JSON.parse(r.content!) as {
      stats: { total: number }
      tasks: { title: string }[]
    }
    expect(parsed.stats.total).toBe(1)
    expect(parsed.tasks[0].title).toBe("hello")
    // Display always has ANSI regardless of format.
    expect(r.display).toMatch(/\x1b\[/)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFirstHash(content: string): string {
  const m = /#([0-9a-f]{6,7})/.exec(content)
  if (!m) throw new Error(`no hash found in: ${content}`)
  return m[1]
}

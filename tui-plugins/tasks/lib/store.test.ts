import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { TaskStore, TaskStoreError } from "./store.ts"

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let tmpHome: string
let sid: string
let store: TaskStore

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "tasks-test-"))
  sid = "test-session-uuid"
  store = new TaskStore(sid, { home: tmpHome })
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

/** Helper: create a store with a deterministic RNG that walks a list. */
function withRand(ids: readonly string[]): TaskStore {
  let i = 0
  return new TaskStore(sid, {
    home: tmpHome,
    rand: () => {
      const id = ids[i++ % ids.length]
      // Convert six hex chars → 3 bytes.
      const buf = Buffer.alloc(3)
      for (let b = 0; b < 3; b++) buf[b] = Number.parseInt(id.slice(b * 2, b * 2 + 2), 16)
      return buf
    },
  })
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("TaskStore constructor", () => {
  test("rejects empty sid", () => {
    expect(() => new TaskStore("", { home: tmpHome })).toThrow(TaskStoreError)
    expect(() => new TaskStore("   ", { home: tmpHome })).toThrow(TaskStoreError)
  })
  test("path follows ~/.minimal-agent/sessions/<sid>.tasks.jsonl", () => {
    expect(store.path).toBe(join(tmpHome, ".minimal-agent", "sessions", `${sid}.tasks.jsonl`))
  })
})

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("empty state", () => {
  test("list() returns empty array when file missing", () => {
    expect(store.list()).toEqual([])
  })
  test("views() returns empty array", () => {
    expect(store.views()).toEqual([])
  })
  test("stats() reports all zeros", () => {
    expect(store.stats()).toEqual({ total: 0, done: 0, doing: 0, todo: 0, canceled: 0 })
  })
})

// ---------------------------------------------------------------------------
// add() and addMany()
// ---------------------------------------------------------------------------

describe("add()", () => {
  test("appends a top-level task and returns it", () => {
    const t = store.add({ title: "Hello" })
    expect(t.id).toMatch(/^[0-9a-f]{6}$/)
    expect(t.title).toBe("Hello")
    expect(t.status).toBe("todo")
    expect(t.parent).toBeNull()
    expect(t.done_at).toBeNull()
    expect(store.list()).toHaveLength(1)
  })
  test("trims the title", () => {
    const t = store.add({ title: "  hello  " })
    expect(t.title).toBe("hello")
  })
  test("throws on empty title", () => {
    expect(() => store.add({ title: "" })).toThrow(/title cannot be empty/)
    expect(() => store.add({ title: "   " })).toThrow(/title cannot be empty/)
  })
  test("explicit status flips done_at when status=done", () => {
    const t = store.add({ title: "x", status: "done" })
    expect(t.done_at).not.toBeNull()
  })
  test("can insert after another top-level task", () => {
    const s = withRand(["aaaaaa", "bbbbbb", "cccccc"])
    s.add({ title: "first" })   // aaaaaa
    s.add({ title: "second" })  // bbbbbb
    s.add({ title: "middle" }, /* after */ 1) // cccccc — inserted after position 1
    const ids = s.list().map((t) => t.id)
    expect(ids).toEqual(["aaaaaa", "cccccc", "bbbbbb"])
  })
})

describe("add() with parent (subtask)", () => {
  test("generates suffix `a` for first child", () => {
    const s = withRand(["aaaaaa"])
    const p = s.add({ title: "parent" })
    const c = s.add({ title: "child", parent: p.id })
    expect(c.id).toBe("aaaaaaa")
    expect(c.parent).toBe("aaaaaa")
  })
  test("walks suffix a → b → c", () => {
    const s = withRand(["aaaaaa"])
    const p = s.add({ title: "parent" })
    const c1 = s.add({ title: "c1", parent: p.id })
    const c2 = s.add({ title: "c2", parent: p.id })
    const c3 = s.add({ title: "c3", parent: p.id })
    expect([c1.id, c2.id, c3.id]).toEqual(["aaaaaaa", "aaaaaab", "aaaaaac"])
  })
  test("removed sibling does NOT free its suffix (stable ids)", () => {
    const s = withRand(["aaaaaa"])
    const p = s.add({ title: "parent" })
    const c1 = s.add({ title: "c1", parent: p.id })
    const c2 = s.add({ title: "c2", parent: p.id })
    s.remove(c1.id)
    const c3 = s.add({ title: "c3", parent: p.id })
    // c3 gets suffix `c` because b is still used and we go max+1, not count.
    expect(c3.id).toBe("aaaaaac")
    expect(c2.id).toBe("aaaaaab")
  })
  test("subtask is inserted immediately after parent's last child", () => {
    const s = withRand(["aaaaaa", "bbbbbb"])
    const p1 = s.add({ title: "p1" })
    s.add({ title: "p2" })
    s.add({ title: "c1", parent: p1.id })
    s.add({ title: "c2", parent: p1.id })
    const ids = s.list().map((t) => t.id)
    expect(ids).toEqual(["aaaaaa", "aaaaaaa", "aaaaaab", "bbbbbb"])
  })
  test("refuses depth-2 nesting", () => {
    const s = withRand(["aaaaaa"])
    const p = s.add({ title: "parent" })
    const c = s.add({ title: "child", parent: p.id })
    expect(() => s.add({ title: "gc", parent: c.id })).toThrow(/depth-2 nesting is not allowed/)
  })
})

describe("addMany()", () => {
  test("creates each task in order", () => {
    const s = withRand(["aaaaaa", "bbbbbb", "cccccc"])
    const out = s.addMany(["one", "two", "three"])
    expect(out).toHaveLength(3)
    expect(out.map((t) => t.title)).toEqual(["one", "two", "three"])
    expect(out.map((t) => t.id)).toEqual(["aaaaaa", "bbbbbb", "cccccc"])
  })
  test("supports a shared parent", () => {
    const s = withRand(["aaaaaa"])
    const p = s.add({ title: "parent" })
    const subs = s.addMany(["c1", "c2"], { parent: p.id })
    expect(subs.map((t) => t.id)).toEqual(["aaaaaaa", "aaaaaab"])
  })
  test("rejects when parent doesn't exist", () => {
    expect(() => store.addMany(["x"], { parent: "deadbe" })).toThrow(/not found/)
  })
})

// ---------------------------------------------------------------------------
// resolve()
// ---------------------------------------------------------------------------

describe("resolve()", () => {
  test("resolves by position (number)", () => {
    const s = withRand(["aaaaaa", "bbbbbb"])
    s.add({ title: "one" })
    s.add({ title: "two" })
    expect(s.resolve(1)!.id).toBe("aaaaaa")
    expect(s.resolve(2)!.id).toBe("bbbbbb")
  })
  test("resolves by bare id", () => {
    const s = withRand(["aaaaaa"])
    s.add({ title: "x" })
    expect(s.resolve("aaaaaa")!.title).toBe("x")
  })
  test("resolves by #-prefixed id", () => {
    const s = withRand(["aaaaaa"])
    s.add({ title: "x" })
    expect(s.resolve("#aaaaaa")!.title).toBe("x")
  })
  test("resolves by stringified position", () => {
    const s = withRand(["aaaaaa"])
    s.add({ title: "x" })
    expect(s.resolve("1")!.id).toBe("aaaaaa")
  })
  test("returns null for unknown id", () => {
    expect(store.resolve("deadbe")).toBeNull()
    expect(store.resolve(99)).toBeNull()
    expect(store.resolve(0)).toBeNull()
    expect(store.resolve(-1)).toBeNull()
    expect(store.resolve("bogus!")).toBeNull()
  })
  test("position numbering skips subtasks", () => {
    const s = withRand(["aaaaaa", "bbbbbb"])
    const p = s.add({ title: "p1" })
    s.add({ title: "c1", parent: p.id })
    s.add({ title: "p2" })
    expect(s.resolve(2)!.title).toBe("p2")
  })

  // Regression: when a 6-char random hash happens to be all digits (about 6%
  // of cases — (10/16)^6 ≈ 0.064), `resolve("398925")` MUST treat the string
  // as a hash, not as a position lookup. The earlier implementation matched
  // `/^\d+$/` first and silently looked up "position 398925" which returns
  // null; the in-flight `done`/`setStatus` then mutated nothing and the test
  // failed intermittently. Pinned here so it can't drift back.
  test("all-digit hash is not misread as a position (regression)", () => {
    const s = withRand(["398925"]) // all decimal digits, still a valid 6-hex id
    const t = s.add({ title: "needle" })
    expect(t.id).toBe("398925")
    // String form (bare and prefixed) AND numeric form behave correctly.
    expect(s.resolve("398925")!.title).toBe("needle")
    expect(s.resolve("#398925")!.title).toBe("needle")
    // The position lookup for position 398925 (no such task) returns null,
    // NOT the hash-shaped task.
    expect(s.resolve(398925)).toBeNull()
    // Setting status by the all-digit hash mutates the right task.
    s.setStatus("398925", "done")
    expect(s.list()[0].status).toBe("done")
  })

  test("all-digit subtask hash is not misread (regression)", () => {
    const s = withRand(["123456"])
    const p = s.add({ title: "parent" })
    const c = s.add({ title: "child", parent: p.id })
    expect(c.id).toBe("123456a")
    expect(s.resolve("123456a")!.title).toBe("child")
    expect(s.resolve("#123456a")!.title).toBe("child")
  })
})

// ---------------------------------------------------------------------------
// update(), setStatus(), start(), done()
// ---------------------------------------------------------------------------

describe("update()", () => {
  test("changes title", () => {
    const s = withRand(["aaaaaa"])
    const t = s.add({ title: "before" })
    const u = s.update(t.id, "after")
    expect(u!.title).toBe("after")
    expect(s.list()[0].title).toBe("after")
  })
  test("returns null for unknown id", () => {
    expect(store.update("deadbe", "x")).toBeNull()
  })
  test("rejects empty title", () => {
    const s = withRand(["aaaaaa"])
    const t = s.add({ title: "x" })
    expect(() => s.update(t.id, "")).toThrow(/title cannot be empty/)
  })
})

describe("setStatus()", () => {
  test("flips status and stamps done_at on done", () => {
    const s = withRand(["aaaaaa"])
    const t = s.add({ title: "x" })
    const u = s.setStatus(t.id, "done")
    expect(u!.status).toBe("done")
    expect(u!.done_at).not.toBeNull()
  })
  test("clears done_at when flipping away from done", () => {
    const s = withRand(["aaaaaa"])
    const t = s.add({ title: "x", status: "done" })
    expect(t.done_at).not.toBeNull()
    const u = s.setStatus(t.id, "doing")
    expect(u!.done_at).toBeNull()
  })
  test("records reason when setting canceled", () => {
    const s = withRand(["aaaaaa"])
    const t = s.add({ title: "x" })
    const u = s.setStatus(t.id, "canceled", "user redirected")
    expect(u!.reason).toBe("user redirected")
    expect(u!.status).toBe("canceled")
  })
  test("returns null for unknown id", () => {
    expect(store.setStatus("deadbe", "done")).toBeNull()
  })
})

describe("start() / single-doing discipline", () => {
  test("flips target to doing", () => {
    const s = withRand(["aaaaaa"])
    const t = s.add({ title: "x" })
    const u = s.start(t.id)
    expect(u!.status).toBe("doing")
  })
  test("auto-demotes other top-level doing tasks", () => {
    const s = withRand(["aaaaaa", "bbbbbb"])
    const t1 = s.add({ title: "one", status: "doing" })
    s.add({ title: "two" })
    s.start(2)
    const list = s.list()
    expect(list.find((t) => t.id === t1.id)!.status).toBe("todo")
    expect(list.find((t) => t.id === "bbbbbb")!.status).toBe("doing")
  })
  test("parallel: true skips demotion", () => {
    const s = withRand(["aaaaaa", "bbbbbb"])
    s.add({ title: "one", status: "doing" })
    s.add({ title: "two" })
    s.start(2, { parallel: true })
    expect(s.list().filter((t) => t.status === "doing")).toHaveLength(2)
  })
  test("subtask doing demotes sibling doings only, not top-level", () => {
    const s = withRand(["aaaaaa", "bbbbbb"])
    const p = s.add({ title: "parent", status: "doing" })
    s.addMany(["c1", "c2"], { parent: p.id })
    // Start subtask c1 (suffix a) — should NOT demote the parent
    s.setStatus(`${p.id}a`, "doing")
    s.start(`${p.id}b`)
    const list = s.list()
    expect(list.find((t) => t.id === p.id)!.status).toBe("doing")
    expect(list.find((t) => t.id === `${p.id}a`)!.status).toBe("todo")
    expect(list.find((t) => t.id === `${p.id}b`)!.status).toBe("doing")
  })
})

describe("done()", () => {
  test("is sugar for setStatus(_, done)", () => {
    const s = withRand(["aaaaaa"])
    const t = s.add({ title: "x" })
    const u = s.done(t.id)
    expect(u!.status).toBe("done")
    expect(u!.done_at).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// remove()
// ---------------------------------------------------------------------------

describe("remove()", () => {
  test("removes a top-level task", () => {
    const s = withRand(["aaaaaa"])
    s.add({ title: "x" })
    const removed = s.remove(1)
    expect(removed).toHaveLength(1)
    expect(s.list()).toEqual([])
  })
  test("cascades subtasks", () => {
    const s = withRand(["aaaaaa", "bbbbbb"])
    const p = s.add({ title: "parent" })
    s.addMany(["c1", "c2"], { parent: p.id })
    s.add({ title: "other" })
    const removed = s.remove(p.id)
    expect(removed).toHaveLength(3) // parent + 2 children
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0].title).toBe("other")
  })
  test("returns [] for unknown id", () => {
    expect(store.remove("deadbe")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// reorder()
// ---------------------------------------------------------------------------

describe("reorder()", () => {
  test("reorders top-level tasks", () => {
    const s = withRand(["aaaaaa", "bbbbbb", "cccccc"])
    s.add({ title: "1" })
    s.add({ title: "2" })
    s.add({ title: "3" })
    s.reorder(["#cccccc", "#aaaaaa", "#bbbbbb"])
    expect(s.list().map((t) => t.id)).toEqual(["cccccc", "aaaaaa", "bbbbbb"])
  })
  test("subtasks ride along with their parent", () => {
    const s = withRand(["aaaaaa", "bbbbbb"])
    const p1 = s.add({ title: "p1" })
    s.addMany(["c1", "c2"], { parent: p1.id })
    s.add({ title: "p2" })
    s.reorder(["#bbbbbb", "#aaaaaa"])
    const ids = s.list().map((t) => t.id)
    expect(ids).toEqual(["bbbbbb", "aaaaaa", "aaaaaaa", "aaaaaab"])
  })
  test("missing top-levels go to the end in prior order", () => {
    const s = withRand(["aaaaaa", "bbbbbb", "cccccc"])
    s.add({ title: "1" })
    s.add({ title: "2" })
    s.add({ title: "3" })
    s.reorder(["#bbbbbb"]) // only one mentioned
    expect(s.list().map((t) => t.id)).toEqual(["bbbbbb", "aaaaaa", "cccccc"])
  })
  test("rejects subtask id in order", () => {
    const s = withRand(["aaaaaa"])
    const p = s.add({ title: "parent" })
    s.add({ title: "child", parent: p.id })
    expect(() => s.reorder([`${p.id}a`])).toThrow(/subtask/)
  })
  test("rejects unknown id", () => {
    expect(() => store.reorder(["#deadbe"])).toThrow(/not found/)
  })
  test("rejects duplicate", () => {
    const s = withRand(["aaaaaa", "bbbbbb"])
    s.add({ title: "1" })
    s.add({ title: "2" })
    expect(() => s.reorder(["#aaaaaa", "#aaaaaa"])).toThrow(/duplicate/)
  })
})

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

describe("clear()", () => {
  test("wipes all when no doing tasks", () => {
    const s = withRand(["aaaaaa", "bbbbbb"])
    s.add({ title: "1" })
    s.add({ title: "2" })
    expect(s.clear()).toBe(2)
    expect(s.list()).toEqual([])
  })
  test("refuses when a task is doing (without force)", () => {
    const s = withRand(["aaaaaa"])
    s.add({ title: "x", status: "doing" })
    expect(() => s.clear()).toThrow(/refusing to clear/)
    expect(s.list()).toHaveLength(1) // unchanged
  })
  test("force: true clears anyway", () => {
    const s = withRand(["aaaaaa"])
    s.add({ title: "x", status: "doing" })
    expect(s.clear(true)).toBe(1)
    expect(s.list()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// views() and stats()
// ---------------------------------------------------------------------------

describe("views()", () => {
  test("numbers top-level 1, 2, 3", () => {
    const s = withRand(["aaaaaa", "bbbbbb", "cccccc"])
    s.add({ title: "1" })
    s.add({ title: "2" })
    s.add({ title: "3" })
    const v = s.views()
    expect(v.map((x) => x.n)).toEqual([1, 2, 3])
  })
  test("subtasks have n: null and childIndex/siblingCount set", () => {
    const s = withRand(["aaaaaa"])
    const p = s.add({ title: "parent" })
    s.addMany(["c1", "c2", "c3"], { parent: p.id })
    const v = s.views()
    expect(v[0].n).toBe(1)
    expect(v[1].n).toBeNull()
    expect(v[1].childIndex).toBe(0)
    expect(v[1].siblingCount).toBe(3)
    expect(v[3].childIndex).toBe(2)
  })
})

describe("stats()", () => {
  test("counts each status correctly", () => {
    const s = withRand(["aaaaaa", "bbbbbb", "cccccc", "dddddd", "eeeeee"])
    s.add({ title: "1", status: "done" })
    s.add({ title: "2", status: "done" })
    s.add({ title: "3", status: "doing" })
    s.add({ title: "4", status: "todo" })
    s.add({ title: "5", status: "canceled" })
    expect(s.stats()).toEqual({ total: 5, done: 2, doing: 1, todo: 1, canceled: 1 })
  })
})

// ---------------------------------------------------------------------------
// Persistence round-trip
// ---------------------------------------------------------------------------

describe("persistence", () => {
  test("a second TaskStore on the same sid reads what the first wrote", () => {
    const s1 = withRand(["aaaaaa"])
    s1.add({ title: "from-first-store" })
    const s2 = new TaskStore(sid, { home: tmpHome })
    expect(s2.list().map((t) => t.title)).toEqual(["from-first-store"])
  })
})

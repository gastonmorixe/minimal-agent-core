import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Task } from "./parse.ts"
import { applyStatusTransition, TaskStore, TaskStoreError } from "./store.ts"

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
  test("relocates under MINIMAL_AGENT_HOME when no home dep is injected", () => {
    // No `deps.home` → the path resolver reads live env, where
    // MINIMAL_AGENT_HOME is authoritative (the shared agent-paths resolver).
    const prev = process.env.MINIMAL_AGENT_HOME
    const relocated = mkdtempSync(join(tmpdir(), "tasks-relocate-"))
    try {
      process.env.MINIMAL_AGENT_HOME = relocated
      const relocatedStore = new TaskStore(sid, {})
      expect(relocatedStore.path).toBe(join(relocated, "sessions", `${sid}.tasks.jsonl`))
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prev
      rmSync(relocated, { recursive: true, force: true })
    }
  })
  test("explicit home dep overrides any ambient MINIMAL_AGENT_HOME", () => {
    // The injected `deps.home` is mapped to HOME, which the resolver honors
    // ahead of homedir() but BEHIND MINIMAL_AGENT_HOME — so clear the latter
    // to keep this default-home assertion robust against an ambient var.
    const prev = process.env.MINIMAL_AGENT_HOME
    try {
      delete process.env.MINIMAL_AGENT_HOME
      const scoped = new TaskStore(sid, { home: tmpHome })
      expect(scoped.path).toBe(join(tmpHome, ".minimal-agent", "sessions", `${sid}.tasks.jsonl`))
    } finally {
      if (prev !== undefined) process.env.MINIMAL_AGENT_HOME = prev
    }
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
    s.add({ title: "first" }) // aaaaaa
    s.add({ title: "second" }) // bbbbbb
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
  test("canceled → done clears the bogus reason and stamps done_at", () => {
    // Recovery path for the May 2026 PROMPT.md issue: an earlier turn
    // marked a phase header `canceled` with reason "phase header, all
    // subtasks done" thinking that meant "phase complete". The
    // intended status was `done`. Flipping canceled → done must clear
    // the now-bogus reason and stamp done_at, so the row paints lime
    // ✔ with no parenthetical and the closer count moves from
    // "canceled" into "done".
    const s = withRand(["aaaaaa"])
    const t = s.add({ title: "PHASE 1 · Setup" })
    s.setStatus(t.id, "canceled", "phase header, all subtasks done")
    const after = s.list()[0]
    expect(after.status).toBe("canceled")
    expect(after.reason).toBe("phase header, all subtasks done")
    const fixed = s.setStatus(t.id, "done")
    expect(fixed!.status).toBe("done")
    expect(fixed!.reason).toBeNull()
    expect(fixed!.done_at).not.toBeNull()
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

// ---------------------------------------------------------------------------
// Duration tracking (schema v2)
// ---------------------------------------------------------------------------

/** Helper: build a minimal Task literal with v2 defaults. */
function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "a7b3c4",
    parent: null,
    status: "todo",
    title: "T",
    created_at: "2026-05-20T18:00:00-04:00",
    done_at: null,
    reason: null,
    started_at: null,
    last_resumed_at: null,
    active_ms: 0,
    ...over,
  }
}

describe("applyStatusTransition — pure timing math", () => {
  const nowIso = "2026-05-20T18:01:30-04:00"
  const nowMs = Date.parse(nowIso)

  test("todo → doing: stamps started_at and last_resumed_at, active_ms unchanged", () => {
    const next = applyStatusTransition(makeTask(), "doing", nowIso, nowMs)
    expect(next.status).toBe("doing")
    expect(next.started_at).toBe(nowIso)
    expect(next.last_resumed_at).toBe(nowIso)
    expect(next.active_ms).toBe(0)
  })

  test("doing → done: accrues now-last_resumed_at into active_ms and clears last_resumed_at", () => {
    const resumedAt = "2026-05-20T18:00:30-04:00"
    const prev = makeTask({
      status: "doing",
      started_at: resumedAt,
      last_resumed_at: resumedAt,
      active_ms: 5_000,
    })
    const next = applyStatusTransition(prev, "done", nowIso, nowMs)
    expect(next.status).toBe("done")
    expect(next.last_resumed_at).toBeNull()
    // active_ms started at 5s, added (18:01:30 - 18:00:30) = 60s → 65_000.
    expect(next.active_ms).toBe(65_000)
    // done_at stamped to now.
    expect(next.done_at).toBe(nowIso)
    // started_at preserved.
    expect(next.started_at).toBe(resumedAt)
  })

  test("doing → todo: same accrual, clears last_resumed_at, keeps started_at", () => {
    const resumedAt = "2026-05-20T18:01:00-04:00"
    const prev = makeTask({
      status: "doing",
      started_at: "2026-05-20T18:00:00-04:00",
      last_resumed_at: resumedAt,
      active_ms: 0,
    })
    const next = applyStatusTransition(prev, "todo", nowIso, nowMs)
    expect(next.status).toBe("todo")
    expect(next.last_resumed_at).toBeNull()
    // 18:01:30 - 18:01:00 = 30s.
    expect(next.active_ms).toBe(30_000)
    expect(next.started_at).toBe("2026-05-20T18:00:00-04:00")
  })

  test("todo → todo (no-op): nothing changes except status (idempotent)", () => {
    const prev = makeTask({ active_ms: 0 })
    const next = applyStatusTransition(prev, "todo", nowIso, nowMs)
    expect(next.status).toBe("todo")
    expect(next.started_at).toBeNull()
    expect(next.last_resumed_at).toBeNull()
    expect(next.active_ms).toBe(0)
  })

  test("doing → doing (no-op): preserves started_at / last_resumed_at, active_ms unchanged", () => {
    const prev = makeTask({
      status: "doing",
      started_at: "2026-05-20T18:00:00-04:00",
      last_resumed_at: "2026-05-20T18:00:30-04:00",
      active_ms: 12_000,
    })
    const next = applyStatusTransition(prev, "doing", nowIso, nowMs)
    expect(next.last_resumed_at).toBe("2026-05-20T18:00:30-04:00")
    expect(next.active_ms).toBe(12_000)
  })

  test("done → doing (resume): started_at preserved, last_resumed_at refreshed, active_ms preserved", () => {
    const prev = makeTask({
      status: "done",
      started_at: "2026-05-20T17:00:00-04:00",
      last_resumed_at: null,
      active_ms: 100_000,
      done_at: "2026-05-20T17:30:00-04:00",
    })
    const next = applyStatusTransition(prev, "doing", nowIso, nowMs)
    expect(next.started_at).toBe("2026-05-20T17:00:00-04:00")
    expect(next.last_resumed_at).toBe(nowIso)
    expect(next.active_ms).toBe(100_000)
    expect(next.done_at).toBeNull() // cleared on leaving done
  })

  test("doing → canceled with reason: accrues, sets reason, clears done_at", () => {
    const prev = makeTask({
      status: "doing",
      started_at: "2026-05-20T18:00:00-04:00",
      last_resumed_at: "2026-05-20T18:00:00-04:00",
      active_ms: 0,
    })
    const next = applyStatusTransition(prev, "canceled", nowIso, nowMs, "redirected")
    expect(next.status).toBe("canceled")
    expect(next.reason).toBe("redirected")
    expect(next.active_ms).toBe(90_000) // 90s
    expect(next.last_resumed_at).toBeNull()
  })

  test("canceled → done: clears reason, stamps done_at, preserves duration fields", () => {
    // Recovery transition: an earlier mutation parked the task in
    // `canceled` with a reason, and a follow-up realizes the task
    // actually completed. The reason must clear (it no longer
    // applies), done_at must stamp, and the duration fields ride
    // through untouched (they record real wall-clock history we
    // don't want to lose).
    const prev = makeTask({
      status: "canceled",
      reason: "wrongly canceled",
      started_at: null,
      last_resumed_at: null,
      active_ms: 5_000,
      done_at: null,
    })
    const next = applyStatusTransition(prev, "done", nowIso, nowMs)
    expect(next.status).toBe("done")
    expect(next.reason).toBeNull()
    expect(next.done_at).toBe(nowIso)
    expect(next.active_ms).toBe(5_000)
    expect(next.started_at).toBeNull()
    expect(next.last_resumed_at).toBeNull()
  })

  test("doing → done with null last_resumed_at (corrupt v1 resume): defensive — no accrual", () => {
    const prev = makeTask({
      status: "doing",
      started_at: "2026-05-20T17:00:00-04:00",
      last_resumed_at: null, // simulates a resumed v1 file where the field wasn't tracked
      active_ms: 0,
    })
    const next = applyStatusTransition(prev, "done", nowIso, nowMs)
    expect(next.active_ms).toBe(0)
    expect(next.last_resumed_at).toBeNull()
  })
})

describe("TaskStore — duration accrual through public methods", () => {
  test("add({status: 'doing'}) seeds started_at + last_resumed_at = created_at", () => {
    // Inject a fixed clock so we can pin the seeded fields exactly.
    const fixed = new Date(2026, 4, 20, 18, 0, 0)
    const s = new TaskStore(sid, {
      home: tmpHome,
      now: () => fixed,
      rand: () => Buffer.from([0xa7, 0xb3, 0xc4]),
    })
    const t = s.add({ title: "Immediate", status: "doing" })
    expect(t.started_at).toBe(t.created_at)
    expect(t.last_resumed_at).toBe(t.created_at)
    expect(t.active_ms).toBe(0)
  })

  test("setStatus(doing) → setStatus(done): accrues elapsed wall-time", () => {
    // Each public mutation calls `deps.now()` exactly once (via nowPair
    // or via add()'s `localIsoSeconds`). Three mutations → three ticks.
    const t0 = new Date(2026, 4, 20, 18, 0, 0) // add
    const t1 = new Date(2026, 4, 20, 18, 0, 0) // setStatus(doing) — same moment
    const t2 = new Date(2026, 4, 20, 18, 0, 12) // setStatus(done) — +12s
    const ticks = [t0, t1, t2]
    let i = 0
    const s = new TaskStore(sid, {
      home: tmpHome,
      now: () => ticks[Math.min(i++, ticks.length - 1)],
      rand: () => Buffer.from([0xa7, 0xb3, 0xc4]),
    })
    const created = s.add({ title: "Time me" })
    s.setStatus(created.id, "doing")
    const done = s.setStatus(created.id, "done")
    expect(done).not.toBeNull()
    expect(done!.active_ms).toBe(12_000)
    expect(done!.started_at).toBeTruthy()
    expect(done!.last_resumed_at).toBeNull()
  })

  test("start() demotion path accrues sibling's active_ms before flipping to todo", () => {
    // Sequence: add A → add B → start A → start B. Four mutations,
    // four ticks. start B fires the demote of A which accrues at t3.
    const t0 = new Date(2026, 4, 20, 18, 0, 0) // add A
    const t1 = new Date(2026, 4, 20, 18, 0, 0) // add B
    const t2 = new Date(2026, 4, 20, 18, 0, 0) // start A (A enters doing)
    const t3 = new Date(2026, 4, 20, 18, 0, 5) // start B (demotes A, +5s)
    let i = 0
    const ticks = [t0, t1, t2, t3]
    const s = new TaskStore(sid, {
      home: tmpHome,
      now: () => ticks[Math.min(i++, ticks.length - 1)],
      rand: () => {
        // Two ids, alternating based on how many randomBytes calls so far.
        // The store's add() retries on collision; we don't expect a
        // collision here so this is one call per add.
        const ids = ["aaaaaa", "bbbbbb"]
        const id = ids[i % 2]
        const buf = Buffer.alloc(3)
        for (let b = 0; b < 3; b++) buf[b] = Number.parseInt(id.slice(b * 2, b * 2 + 2), 16)
        return buf
      },
    })
    const a = s.add({ title: "A" })
    const b = s.add({ title: "B" })
    s.start(a.id)
    s.start(b.id) // demotes A back to todo, accruing its 5s
    const post = s.list()
    const aPost = post.find((t) => t.id === a.id)!
    const bPost = post.find((t) => t.id === b.id)!
    expect(aPost.status).toBe("todo")
    expect(aPost.active_ms).toBe(5_000)
    expect(aPost.last_resumed_at).toBeNull()
    // started_at on A is preserved across the demote — useful for showing
    // "this task was first started at 18:00:00" even after a pause.
    expect(aPost.started_at).not.toBeNull()
    expect(bPost.status).toBe("doing")
    expect(bPost.last_resumed_at).not.toBeNull()
  })

  test("multiple doing/todo/doing cycles accumulate active_ms across resumes", () => {
    const ticks = [
      new Date(2026, 4, 20, 18, 0, 0), // add
      new Date(2026, 4, 20, 18, 0, 10), // setStatus doing #1
      new Date(2026, 4, 20, 18, 0, 17), // setStatus todo (accrues 7s)
      new Date(2026, 4, 20, 18, 0, 25), // setStatus doing #2
      new Date(2026, 4, 20, 18, 0, 30), // setStatus done (accrues 5s) → 12s total
    ]
    let i = 0
    const s = new TaskStore(sid, {
      home: tmpHome,
      now: () => ticks[Math.min(i++, ticks.length - 1)],
      rand: () => Buffer.from([0xa7, 0xb3, 0xc4]),
    })
    const t = s.add({ title: "Cycle" })
    s.setStatus(t.id, "doing")
    s.setStatus(t.id, "todo")
    s.setStatus(t.id, "doing")
    const done = s.setStatus(t.id, "done")
    expect(done!.active_ms).toBe(12_000)
  })

  test("nowPair() samples deps.now() exactly once per mutation (no millisecond drift)", () => {
    // Regression: prior to the nowPair() helper, the store called
    // deps.now() once for the ISO and once for the epoch. Tests that
    // injected `() => new Date()` (real wall clock) could see ISO and
    // epoch sampled on opposite sides of a millisecond boundary, leading
    // to an active_ms that was off by 1 from the test's expectation. The
    // counter below pins "one call per mutation".
    let calls = 0
    const fixed = new Date(2026, 4, 20, 18, 0, 0)
    const s = new TaskStore(sid, {
      home: tmpHome,
      now: () => {
        calls++
        return new Date(fixed.getTime() + calls * 1000)
      },
      rand: () => Buffer.from([0xa7, 0xb3, 0xc4]),
    })
    const before = calls
    s.add({ title: "x" })
    expect(calls - before).toBe(1) // add
    const after1 = calls
    const t = s.list()[0]
    s.setStatus(t.id, "doing")
    expect(calls - after1).toBe(1) // setStatus
    const after2 = calls
    s.setStatus(t.id, "done")
    expect(calls - after2).toBe(1) // setStatus
  })
})

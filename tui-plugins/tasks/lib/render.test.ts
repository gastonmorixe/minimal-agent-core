import { describe, expect, test } from "bun:test"

import { GLYPHS, renderBlock, type RenderOptions } from "./render.ts"
import type { Task } from "./parse.ts"
import type { View, Stats } from "./store.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function task(over: Partial<Task> = {}): Task {
  return {
    id: "a7b3c4",
    parent: null,
    status: "todo",
    title: "Sample task",
    created_at: "2026-05-12T15:30:00-04:00",
    done_at: null,
    reason: null,
    ...over,
  }
}

function topView(t: Task, n: number): View {
  return { task: t, n, childIndex: null, siblingCount: null }
}

function subView(t: Task, childIndex: number, siblingCount: number): View {
  return { task: t, n: null, childIndex, siblingCount }
}

function stats(over: Partial<Stats> = {}): Stats {
  return { total: 0, done: 0, doing: 0, todo: 0, canceled: 0, ...over }
}

function plain(views: readonly View[], s: Stats, opts: Partial<RenderOptions> = {}): string {
  return renderBlock(views, s, { ansi: false, action: { kind: "list" }, ...opts })
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("renderBlock — empty", () => {
  test("renders the empty list view with frame and call-to-action", () => {
    const out = plain([], stats(), { action: { kind: "list" } })
    expect(out).toContain(`${GLYPHS.frameTL} ${GLYPHS.pending} Tasks`)
    expect(out).toContain("no tasks")
    expect(out).toContain("Task({action:")
    expect(out).toContain(GLYPHS.frameBL)
  })
  test("renders the cleared state similarly", () => {
    const out = plain([], stats(), { action: { kind: "cleared", count: 3 } })
    expect(out).toContain("cleared")
    expect(out).toContain("3 tasks")
  })
})

// ---------------------------------------------------------------------------
// Frame structure
// ---------------------------------------------------------------------------

describe("renderBlock — frame structure", () => {
  test("starts with ╭ header, has │ gaps, ends with ╰ closer", () => {
    const v = topView(task(), 1)
    const out = plain([v], stats({ total: 1, todo: 1 }))
    const lines = out.trimEnd().split("\n")
    expect(lines[0].startsWith(GLYPHS.frameTL)).toBe(true)
    expect(lines[1].startsWith(GLYPHS.frameML)).toBe(true)
    expect(lines.at(-1)!.startsWith(GLYPHS.frameBL)).toBe(true)
  })
  test("has blank │ rows above and below the task rows", () => {
    const v = topView(task(), 1)
    const out = plain([v], stats({ total: 1, todo: 1 }))
    const lines = out.trimEnd().split("\n")
    // Expect: header, gap, row, gap, closer
    expect(lines).toHaveLength(5)
    expect(lines[1]).toBe(GLYPHS.frameML)
    expect(lines[3]).toBe(GLYPHS.frameML)
  })
})

// ---------------------------------------------------------------------------
// Header verbs
// ---------------------------------------------------------------------------

describe("renderBlock — header verbs", () => {
  const v = topView(task({ status: "done", done_at: "2026-05-12T15:31:00-04:00" }), 1)
  const s = stats({ total: 1, done: 1 })

  test("marked_done shows ✔ marked done #<hash>", () => {
    const out = plain([v], s, { action: { kind: "marked_done", hash: "a7b3c4" } })
    const head = out.split("\n")[0]
    expect(head).toContain(`${GLYPHS.done} marked done #a7b3c4`)
    expect(head).toContain("1/1")
  })
  test("started shows ◐ started #<hash>", () => {
    const out = plain([v], s, { action: { kind: "started", hash: "a7b3c4" } })
    expect(out.split("\n")[0]).toContain(`${GLYPHS.doing} started #a7b3c4`)
  })
  test("added shows + added #<hash>", () => {
    const out = plain([v], s, { action: { kind: "added", hash: "a7b3c4" } })
    expect(out.split("\n")[0]).toContain(`${GLYPHS.plus} added #a7b3c4`)
  })
  test("added_many shows + added N tasks (no #<hash>)", () => {
    const out = plain([v], s, { action: { kind: "added_many", count: 5 } })
    expect(out.split("\n")[0]).toContain(`${GLYPHS.plus} added 5 tasks`)
    expect(out.split("\n")[0]).not.toContain("#a7b3c4")
  })
  test("all_done flips the N/M to lime and reads 'all done'", () => {
    const out = plain([v], s, { action: { kind: "all_done" } })
    expect(out.split("\n")[0]).toContain(`${GLYPHS.done} all done`)
    expect(out.split("\n")[0]).toContain("1/1")
  })
  test("removed shows ✘ removed #<hash>", () => {
    const out = plain([v], s, { action: { kind: "removed", hash: "a7b3c4" } })
    expect(out.split("\n")[0]).toContain(`${GLYPHS.canceled} removed #a7b3c4`)
  })
  test("marked_canceled shows ✘ canceled #<hash>", () => {
    const out = plain([v], s, { action: { kind: "marked_canceled", hash: "a7b3c4" } })
    expect(out.split("\n")[0]).toContain(`${GLYPHS.canceled} canceled #a7b3c4`)
  })
  test("list with zero tasks → 'no tasks'", () => {
    const out = plain([], stats(), { action: { kind: "list" } })
    expect(out.split("\n")[0]).toContain("no tasks")
  })
  test("list with N tasks → 'N tasks'", () => {
    const out = plain([v], s, { action: { kind: "list" } })
    expect(out.split("\n")[0]).toContain("1 task") // singular
  })
})

// ---------------------------------------------------------------------------
// Row rendering per status
// ---------------------------------------------------------------------------

describe("renderBlock — top-level rows", () => {
  test("done row has bold check, dim+strike title", () => {
    const t = task({ status: "done", title: "x", done_at: "2026-05-12T15:31:00-04:00" })
    const out = plain([topView(t, 1)], stats({ total: 1, done: 1 }))
    expect(out).toContain(` 1  ${GLYPHS.done}  #a7b3c4  x`)
  })
  test("doing row has half-circle glyph and bold title", () => {
    const t = task({ status: "doing", title: "x" })
    const out = plain([topView(t, 1)], stats({ total: 1, doing: 1 }))
    expect(out).toContain(` 1  ${GLYPHS.doing}  #a7b3c4  x`)
  })
  test("todo row has dim circle glyph and plain title", () => {
    const t = task({ status: "todo", title: "x" })
    const out = plain([topView(t, 1)], stats({ total: 1, todo: 1 }))
    expect(out).toContain(` 1  ${GLYPHS.pending}  #a7b3c4  x`)
  })
  test("canceled row has ○ in status column, ✘ prefix on title, (reason) suffix", () => {
    const t = task({ status: "canceled", title: "abandon", reason: "user redirected" })
    const out = plain([topView(t, 1)], stats({ total: 1, canceled: 1 }))
    expect(out).toContain(` 1  ${GLYPHS.pending}  #a7b3c4  ${GLYPHS.canceled} abandon  (user redirected)`)
  })
  test("number column right-aligns to width 2", () => {
    const t1 = task({ id: "aaaaaa", title: "one" })
    const t2 = task({ id: "bbbbbb", title: "two" })
    const lines = plain(
      [topView(t1, 1), topView(t2, 10)],
      stats({ total: 10, todo: 10 }),
    ).split("\n")
    // top-level rows are between gaps; find them
    const dataRows = lines.filter((l) => l.includes("#"))
    expect(dataRows[0]).toContain(" 1  ")
    expect(dataRows[1]).toContain("10  ")
  })
})

// ---------------------------------------------------------------------------
// Subtask tree
// ---------------------------------------------------------------------------

describe("renderBlock — subtasks", () => {
  const parent = task({ id: "d04c91", status: "doing", title: "parent" })
  const child1 = task({ id: "d04c91a", parent: "d04c91", status: "done", title: "c1", done_at: "x" })
  const child2 = task({ id: "d04c91b", parent: "d04c91", status: "doing", title: "c2" })
  const child3 = task({ id: "d04c91c", parent: "d04c91", status: "todo", title: "c3" })

  test("uses ├ for mid children and ╰ for last child", () => {
    const views: View[] = [
      topView(parent, 1),
      subView(child1, 0, 3),
      subView(child2, 1, 3),
      subView(child3, 2, 3),
    ]
    const out = plain(views, stats({ total: 4, done: 1, doing: 2, todo: 1 }))
    expect(out).toContain(`${GLYPHS.treeMid}  ${GLYPHS.done}  #d04c91a  c1`)
    expect(out).toContain(`${GLYPHS.treeMid}  ${GLYPHS.doing}  #d04c91b  c2`)
    expect(out).toContain(`${GLYPHS.treeLast}  ${GLYPHS.pending}  #d04c91c  c3`)
  })
  test("single child uses ╰ (siblingCount=1, childIndex=0)", () => {
    const views: View[] = [topView(parent, 1), subView(child1, 0, 1)]
    const out = plain(views, stats({ total: 2, done: 1, doing: 1 }))
    expect(out).toContain(`${GLYPHS.treeLast}  ${GLYPHS.done}`)
  })
})

// ---------------------------------------------------------------------------
// Closer
// ---------------------------------------------------------------------------

describe("renderBlock — closer", () => {
  test("shows N done · M doing · K todo", () => {
    const t = task({ status: "todo" })
    const out = plain([topView(t, 1)], stats({ total: 1, todo: 1 }))
    const lines = out.trimEnd().split("\n")
    expect(lines.at(-1)).toContain("0 done")
    expect(lines.at(-1)).toContain("0 doing")
    expect(lines.at(-1)).toContain("1 todo")
  })
  test("appends 'X canceled' only when count > 0", () => {
    const t = task({ status: "todo" })
    const out1 = plain([topView(t, 1)], stats({ total: 1, todo: 1 }))
    const out2 = plain([topView(t, 1)], stats({ total: 2, todo: 1, canceled: 1 }))
    expect(out1.trimEnd().split("\n").at(-1)).not.toContain("canceled")
    expect(out2.trimEnd().split("\n").at(-1)).toContain("1 canceled")
  })
})

// ---------------------------------------------------------------------------
// ANSI emission
// ---------------------------------------------------------------------------

describe("renderBlock — ANSI", () => {
  test("ansi:false emits no escape sequences", () => {
    const t = task({ status: "doing" })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, doing: 1 }), {
      ansi: false,
      action: { kind: "list" },
    })
    expect(out).not.toMatch(/\x1b\[/)
  })
  test("ansi:true emits escape sequences (color and reset)", () => {
    const t = task({ status: "doing" })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, doing: 1 }), {
      ansi: true,
      action: { kind: "list" },
    })
    expect(out).toMatch(/\x1b\[/)
    expect(out).toContain("\x1b[0m") // reset
  })
})

// ---------------------------------------------------------------------------
// Title truncation
// ---------------------------------------------------------------------------

describe("renderBlock — title truncation", () => {
  test("respects maxTitleLen", () => {
    const t = task({ title: "this is quite a long title that should get cut off" })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, todo: 1 }), {
      ansi: false,
      action: { kind: "list" },
      maxTitleLen: 20,
    })
    expect(out).toContain("this is quite a lon…")
    expect(out).not.toContain("should get cut off")
  })
  test("leaves short titles unchanged", () => {
    const t = task({ title: "short" })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, todo: 1 }), {
      ansi: false,
      action: { kind: "list" },
      maxTitleLen: 20,
    })
    expect(out).toContain("short")
    expect(out).not.toContain("…")
  })
})

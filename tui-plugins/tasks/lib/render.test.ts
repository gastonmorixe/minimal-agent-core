import { describe, expect, test } from "bun:test"

import { GLYPHS, renderBlock, renderToolDisplay, type RenderOptions } from "./render.ts"
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

describe("renderToolDisplay — host-owned frame parts", () => {
  test("returns header, unframed body, and footer separately", () => {
    const v = topView(task({ status: "doing", title: "x" }), 1)
    const out = renderToolDisplay([v], stats({ total: 1, doing: 1 }), {
      ansi: false,
      action: { kind: "started", hash: "a7b3c4" },
    })
    expect(out.header).toContain(`${GLYPHS.doing} started #a7b3c4`)
    expect(out.body).toContain(`  1  ${GLYPHS.doing}  #a7b3c4  x`)
    expect(out.body).not.toContain(GLYPHS.frameTL)
    expect(out.body).not.toContain(GLYPHS.frameML)
    expect(out.footer).toContain("1 doing")
  })
  test("keeps multiline titles from breaking the host frame", () => {
    const parent = task({ id: "3b6c0e", title: "Refactor session\n\ntoken accounting" })
    const child = task({
      id: "3b6c0ea",
      parent: "3b6c0e",
      status: "done",
      title: "Replace cumulative\n\n total",
      done_at: "2026-05-12T15:31:00-04:00",
    })
    const next = task({ id: "b6bd6e", title: "Polish live-area footer rendering" })
    const out = renderToolDisplay(
      [topView(parent, 1), subView(child, 0, 1), topView(next, 2)],
      stats({ total: 3, done: 1, todo: 2 }),
      { ansi: false, action: { kind: "marked_done", hash: "3b6c0ea" } },
    )

    expect(out.body).toContain("Refactor session token accounting")
    expect(out.body).toContain("Replace cumulative total")
    expect(out.body).not.toContain("\n\n")
  })
  test("keeps multiline cancel reasons on one rendered row", () => {
    const v = topView(task({ status: "canceled", title: "drop branch", reason: "user\n\nchanged direction" }), 1)
    const out = renderToolDisplay([v], stats({ total: 1, canceled: 1 }), {
      ansi: false,
      action: { kind: "marked_canceled", hash: "a7b3c4" },
    })

    expect(out.body).toContain("(user changed direction)")
    expect(out.body).not.toContain("\n\n")
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
// Ghost-removed overlay (post-remove tombstone)
// ---------------------------------------------------------------------------

describe("renderBlock — ghost-removed overlay", () => {
  function ghostView(t: Task, n: number): View {
    return { task: t, n, childIndex: null, siblingCount: null, ghost: "removed" }
  }

  test("plain-text: ghost row keeps its original position number and shows ✘ + title", () => {
    // Pre-state had 3 tasks. User removed #2. The renderer is fed the
    // PRE-state views with `ghost: "removed"` stamped on the deleted row,
    // and post-state stats. Result: all three rows appear (the user sees
    // WHAT was removed) but the closer reflects 2 todo.
    const a = task({ id: "aaaaaa", title: "alpha" })
    const b = task({ id: "bbbbbb", title: "beta" })
    const g = task({ id: "cccccc", title: "gamma" })
    const out = plain(
      [topView(a, 1), ghostView(b, 2), topView(g, 3)],
      stats({ total: 2, todo: 2 }), // post-state: only 2 tasks alive
      { action: { kind: "removed", hash: "bbbbbb" } },
    )
    expect(out).toContain(`alpha`)
    expect(out).toContain(`beta`)
    expect(out).toContain(`gamma`)
    // Ghost row carries the canceled glyph in the status column.
    expect(out).toContain(` 2  ${GLYPHS.canceled}  #bbbbbb  beta`)
    // Header verb says "removed".
    expect(out.split("\n")[0]).toContain(`${GLYPHS.canceled} removed #bbbbbb`)
    // Closer reflects post-state.
    expect(out.trimEnd().split("\n").at(-1)).toContain("2 todo")
  })

  test("ansi: ghost row paints title in RED+STRIKE (distinct from canceled's DIM+STRIKE)", () => {
    const b = task({ id: "bbbbbb", title: "beta" })
    const out = renderBlock(
      [ghostView(b, 1)],
      stats({ total: 0 }),
      { ansi: true, action: { kind: "removed", hash: "bbbbbb" } },
    )
    const RED = "\\x1b\\[31m"
    const STRIKE = "\\x1b\\[9m"
    const RESET = "\\x1b\\[0m"
    const nonEsc = "[^\\x1b]*?"
    // Title wears red+strike.
    expect(out).toMatch(new RegExp(RED + STRIKE + nonEsc + "beta" + nonEsc + RESET))
    // Icon is red+bold (matches the canceled icon style).
    expect(out).toContain(`\x1b[31m\x1b[1m${GLYPHS.canceled}\x1b[0m`)
    // Id col is dgray+strike (re-uses the canceled treatment).
    expect(out).toMatch(/\x1b\[38;5;240m\x1b\[9m[^\x1b]*?#bbbbbb[^\x1b]*?\x1b\[0m/)
  })

  test("ghost subtask still renders with its tree connector (└ for last child)", () => {
    const parent = task({ id: "p00000", title: "parent" })
    const child = task({ id: "p00000a", parent: "p00000", title: "child" })
    const out = plain(
      [
        topView(parent, 1),
        { task: child, n: null, childIndex: 0, siblingCount: 1, ghost: "removed" } as View,
      ],
      stats({ total: 1, todo: 1 }),
      { action: { kind: "removed", hash: "p00000a" } },
    )
    // Tree-last connector + ✘ + #id + title — the child is shown as a ghost
    // BUT still visually attached to its parent via the tree glyph.
    expect(out).toContain(`${GLYPHS.treeLast}  ${GLYPHS.canceled}  #p00000a  child`)
  })

  test("ghost row's number column is dim+strike (matches canceled-row dimming)", () => {
    const b = task({ id: "bbbbbb", title: "beta" })
    const out = renderBlock(
      [ghostView(b, 7)],
      stats({ total: 0 }),
      { ansi: true, action: { kind: "removed", hash: "bbbbbb" } },
    )
    const DIM = "\\x1b\\[2m"
    const STRIKE = "\\x1b\\[9m"
    const RESET = "\\x1b\\[0m"
    expect(out).toMatch(new RegExp(DIM + STRIKE + "[^\\x1b]*?7[^\\x1b]*?" + RESET))
  })
})

// ---------------------------------------------------------------------------
// Update diff overlay (old → new inline)
// ---------------------------------------------------------------------------

describe("renderBlock — update diff overlay", () => {
  function diffView(t: Task, n: number, oldTitle: string): View {
    return { task: t, n, childIndex: null, siblingCount: null, diff: { oldTitle } }
  }

  test("plain-text: shows '<old>  →  <new>' inline in the title column", () => {
    const t = task({ id: "abcdef", title: "new title text" })
    const out = plain(
      [diffView(t, 1, "old title text")],
      stats({ total: 1, todo: 1 }),
      { action: { kind: "updated", hash: "abcdef" } },
    )
    expect(out).toContain("old title text")
    expect(out).toContain("→")
    expect(out).toContain("new title text")
    // Order matters: old comes before arrow comes before new. Filter to
    // the BODY row specifically — the header also contains `#abcdef`
    // (via the `updated #abcdef` verb), so a naive `find` returns the
    // wrong line.
    const titleRow = out.split("\n").find((l) => l.startsWith(GLYPHS.frameML) && l.includes("#abcdef"))!
    expect(titleRow).toBeDefined()
    const oldIdx = titleRow.indexOf("old title")
    const arrowIdx = titleRow.indexOf("→")
    const newIdx = titleRow.indexOf("new title")
    expect(oldIdx).toBeGreaterThanOrEqual(0)
    expect(arrowIdx).toBeGreaterThan(oldIdx)
    expect(newIdx).toBeGreaterThan(arrowIdx)
  })

  test("ansi: old half is RED+STRIKE, new half inherits status styling", () => {
    const t = task({ id: "abcdef", status: "doing", title: "new" })
    const out = renderBlock(
      [diffView(t, 1, "old")],
      stats({ total: 1, doing: 1 }),
      { ansi: true, action: { kind: "updated", hash: "abcdef" } },
    )
    const RED = "\\x1b\\[31m"
    const STRIKE = "\\x1b\\[9m"
    const BOLD = "\\x1b\\[1m"
    const RESET = "\\x1b\\[0m"
    const nonEsc = "[^\\x1b]*?"
    // Old → red+strike around the OLD text.
    expect(out).toMatch(new RegExp(RED + STRIKE + nonEsc + "old" + nonEsc + RESET))
    // New → status styling (doing = bold).
    expect(out).toMatch(new RegExp(BOLD + nonEsc + "new" + nonEsc + RESET))
  })

  test("diff overlay preserves the closer/status counts (purely visual)", () => {
    const t = task({ id: "abcdef", title: "renamed" })
    const out = plain(
      [diffView(t, 1, "first")],
      stats({ total: 1, todo: 1 }),
      { action: { kind: "updated", hash: "abcdef" } },
    )
    expect(out.trimEnd().split("\n").at(-1)).toContain("1 todo")
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

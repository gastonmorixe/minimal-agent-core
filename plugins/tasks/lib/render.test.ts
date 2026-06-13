import { describe, expect, test } from "bun:test"

import type { Task } from "./parse.ts"
import { plain, stats, subView, task, topView } from "./render.fixtures.ts"
import { GLYPHS, renderBlock, renderToolDisplay } from "./render.ts"
import type { View } from "./store.ts"

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
    const v = topView(
      task({ status: "canceled", title: "drop branch", reason: "user\n\nchanged direction" }),
      1,
    )
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
  test("all_done flips the N/M to lime and reads 'ALL DONE' (uppercase shout)", () => {
    const out = plain([v], s, { action: { kind: "all_done" } })
    expect(out.split("\n")[0]).toContain(`${GLYPHS.done} ALL DONE`)
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
  test("canceled row has red ✘ in status column, title + (reason) suffix, no title prefix glyph", () => {
    const t = task({ status: "canceled", title: "abandon", reason: "user redirected" })
    const out = plain([topView(t, 1)], stats({ total: 1, canceled: 1 }))
    expect(out).toContain(` 1  ${GLYPHS.canceled}  #a7b3c4  abandon  (user redirected)`)
    // The redundant `✘ ` title prefix is gone (icon column carries it now).
    expect(out).not.toContain(`${GLYPHS.canceled} abandon`)
  })
  test("canceled row: title is RED+STRIKE, reason is RED+DIM+STRIKE, icon is RED+BOLD ✘", () => {
    const t = task({ status: "canceled", title: "abandon", reason: "user redirected" })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, canceled: 1 }), {
      ansi: true,
      action: { kind: "list" },
    })
    const RED = "\\x1b\\[31m"
    const DIM = "\\x1b\\[2m"
    const STRIKE = "\\x1b\\[9m"
    const RESET = "\\x1b\\[0m"
    const nonEsc = "[^\\x1b]*?"
    // Strike applied around the number column (no specific color — kept
    // dim-strike to stay quiet next to the louder red title).
    expect(out).toMatch(new RegExp(STRIKE + nonEsc + "1" + nonEsc + RESET))
    // Strike applied around the id column (DGRAY+STRIKE).
    expect(out).toMatch(new RegExp(STRIKE + nonEsc + "#a7b3c4" + nonEsc + RESET))
    // Title is RED+STRIKE (matches the icon's red identity — whole row
    // reads as one "canceled = red" gesture).
    expect(out).toMatch(new RegExp(RED + STRIKE + nonEsc + "abandon" + nonEsc + RESET))
    // Reason is faint-red (RED+DIM+STRIKE) — softer than the title so
    // the eye reads the title first, parenthetical second, but both
    // stay inside the red color family.
    expect(out).toMatch(
      new RegExp(RED + DIM + STRIKE + nonEsc + "\\(user redirected\\)" + nonEsc + RESET),
    )
    // The red ✘ icon itself is NOT struck through.
    expect(out).toContain(`\x1b[31m\x1b[1m${GLYPHS.canceled}\x1b[0m`)
  })
  test("number column right-aligns to width 2", () => {
    const t1 = task({ id: "aaaaaa", title: "one" })
    const t2 = task({ id: "bbbbbb", title: "two" })
    const lines = plain([topView(t1, 1), topView(t2, 10)], stats({ total: 10, todo: 10 })).split(
      "\n",
    )
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
  const child1 = task({
    id: "d04c91a",
    parent: "d04c91",
    status: "done",
    title: "c1",
    done_at: "x",
  })
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
  test("subtask tree glyph aligns under parent's status glyph column", () => {
    // Top-level body shape: `"  ${numCol(2)}  ${stCol}  …"` puts the
    // parent's status glyph at body offset 6 (2 spaces + 2-char num
    // col + 2 spaces). The subtask's tree glyph (├ / ╰) must land in
    // the SAME body offset so the eye anchors the subtree on the
    // parent's status column. Body offset 6 → 6 leading spaces before
    // the tree glyph. Asserting on the raw line (no frame, no ansi)
    // keeps this independent of the cli vs renderToolDisplay path.
    const views: View[] = [topView(parent, 1), subView(child1, 0, 1)]
    const out = plain(views, stats({ total: 2, done: 1, doing: 1 }))
    const subLine = out
      .split("\n")
      .find((l) => l.includes(GLYPHS.treeLast) && l.includes("#d04c91a"))
    expect(subLine).toBeDefined()
    // After the frame prefix `"│ "` (2 cells) the body begins. The
    // tree glyph should sit 6 body-cells in, i.e. at line offset 8.
    const idx = subLine!.indexOf(GLYPHS.treeLast)
    expect(idx).toBe(8)
    // Same offset as the parent's status glyph on the row above.
    const topLine = out.split("\n").find((l) => l.includes("#d04c91 "))
    expect(topLine).toBeDefined()
    expect(topLine!.indexOf(GLYPHS.doing)).toBe(idx)
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

  // -------------------------------------------------------------------
  // "All done" celebration
  // -------------------------------------------------------------------

  test("ALL DONE state: closer leads with '✦ ALL DONE' (uppercase) and hides zero counts", () => {
    const t1 = task({ id: "aaaaaa", status: "done", title: "first" })
    const t2 = task({ id: "bbbbbb", status: "done", title: "second" })
    const t3 = task({ id: "cccccc", status: "canceled", title: "abandoned" })
    const out = plain(
      [topView(t1, 1), topView(t2, 2), topView(t3, 3)],
      stats({ total: 3, done: 2, canceled: 1 }),
      { action: { kind: "marked_done", hash: "bbbbbb" } },
    )
    const closer = out.trimEnd().split("\n").at(-1)!
    expect(closer).toContain("✦ ALL DONE")
    expect(closer).toContain("2 done")
    expect(closer).toContain("1 canceled")
    // Zero-counts elided in the all-done state — `0 doing` / `0 todo`
    // would just be noise next to the celebration.
    expect(closer).not.toContain("0 doing")
    expect(closer).not.toContain("0 todo")
    // The lowercase form must NOT appear anywhere; uppercase is the
    // single-source-of-truth visual.
    expect(closer).not.toContain("all done")
  })

  test("ALL DONE celebration is suppressed when nothing is actually done", () => {
    // 1 canceled, 0 done — there's nothing to celebrate (we didn't
    // finish anything, the user just bailed out of a single task).
    const t = task({ id: "aaaaaa", status: "canceled", title: "bailed" })
    const out = plain([topView(t, 1)], stats({ total: 1, canceled: 1 }), {
      action: { kind: "marked_canceled", hash: "aaaaaa" },
    })
    const closer = out.trimEnd().split("\n").at(-1)!
    expect(closer).not.toContain("ALL DONE")
    expect(closer).not.toContain("all done")
  })

  test("ALL DONE suppressed mid-progress (any doing or todo remaining)", () => {
    const t1 = task({ id: "aaaaaa", status: "done" })
    const t2 = task({ id: "bbbbbb", status: "doing" })
    const out = plain([topView(t1, 1), topView(t2, 2)], stats({ total: 2, done: 1, doing: 1 }), {
      action: { kind: "marked_done", hash: "aaaaaa" },
    })
    const closer = out.trimEnd().split("\n").at(-1)!
    expect(closer).not.toContain("ALL DONE")
  })

  test("ALL DONE celebration LIME+BOLD ANSI in closer", () => {
    const t = task({ id: "aaaaaa", status: "done", title: "only one" })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, done: 1 }), {
      ansi: true,
      action: { kind: "marked_done", hash: "aaaaaa" },
    })
    const LIME = "\\x1b\\[38;5;118m"
    const BOLD = "\\x1b\\[1m"
    const RESET = "\\x1b\\[0m"
    const nonEsc = "[^\\x1b]*?"
    expect(out).toMatch(new RegExp(LIME + BOLD + nonEsc + "✦ ALL DONE" + nonEsc + RESET))
  })

  test("ALL DONE header suffix appears on the verb row too", () => {
    // marked_done that completes the last task — header should read
    // `✔ marked done #<hash> · ✦ ALL DONE` (suffix appended).
    const t = task({ id: "aaaaaa", status: "done", title: "only one" })
    const out = plain([topView(t, 1)], stats({ total: 1, done: 1 }), {
      action: { kind: "marked_done", hash: "aaaaaa" },
    })
    const headerLine = out.split("\n")[0]
    expect(headerLine).toContain("marked done #aaaaaa")
    expect(headerLine).toContain("✦ ALL DONE")
  })

  test("ALL DONE suffix is NOT appended when action is already all_done", () => {
    // Avoid stutter: handler-dispatched `all_done` already says
    // `✔ ALL DONE` — appending `· ✦ ALL DONE` would double-celebrate.
    const t = task({ id: "aaaaaa", status: "done" })
    const out = plain([topView(t, 1)], stats({ total: 1, done: 1 }), {
      action: { kind: "all_done" },
    })
    const headerLine = out.split("\n")[0]
    // The all_done header still says "ALL DONE" via the verb, but the
    // celebration sparkle is NOT injected as a suffix.
    expect(headerLine).toContain("✔ ALL DONE")
    expect(headerLine).not.toContain("✦ ALL DONE")
  })
})

// ---------------------------------------------------------------------------
// Action-identity colors in header verbs (started/marked_doing/canceled)
// ---------------------------------------------------------------------------

describe("renderBlock — header verb ANSI colors", () => {
  test("started: word 'started' is wrapped in SKY (matches the ◐ icon)", () => {
    const t = task({ id: "aaaaaa", status: "doing" })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, doing: 1 }), {
      ansi: true,
      action: { kind: "started", hash: "aaaaaa" },
    })
    const SKY = "\\x1b\\[38;5;45m"
    const RESET = "\\x1b\\[0m"
    const nonEsc = "[^\\x1b]*?"
    expect(out).toMatch(new RegExp(SKY + nonEsc + "started" + nonEsc + RESET))
  })

  test("marked_doing: word 'marked doing' is wrapped in SKY (symmetric to started)", () => {
    const t = task({ id: "aaaaaa", status: "doing" })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, doing: 1 }), {
      ansi: true,
      action: { kind: "marked_doing", hash: "aaaaaa" },
    })
    const SKY = "\\x1b\\[38;5;45m"
    const RESET = "\\x1b\\[0m"
    const nonEsc = "[^\\x1b]*?"
    expect(out).toMatch(new RegExp(SKY + nonEsc + "marked doing" + nonEsc + RESET))
  })

  test("marked_canceled: word 'canceled' is wrapped in RED (matches the ✘ icon)", () => {
    const t = task({ id: "aaaaaa", status: "canceled" })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, canceled: 1 }), {
      ansi: true,
      action: { kind: "marked_canceled", hash: "aaaaaa" },
    })
    const RED = "\\x1b\\[31m"
    const RESET = "\\x1b\\[0m"
    const nonEsc = "[^\\x1b]*?"
    expect(out).toMatch(new RegExp(RED + nonEsc + "canceled" + nonEsc + RESET))
  })

  test("doing-status row title is SKY+BOLD (matches the ◐ icon)", () => {
    const t = task({ id: "aaaaaa", status: "doing", title: "work in progress" })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, doing: 1 }), {
      ansi: true,
      action: { kind: "list" },
    })
    const SKY = "\\x1b\\[38;5;45m"
    const BOLD = "\\x1b\\[1m"
    const RESET = "\\x1b\\[0m"
    const nonEsc = "[^\\x1b]*?"
    expect(out).toMatch(new RegExp(SKY + BOLD + nonEsc + "work in progress" + nonEsc + RESET))
  })
})

// ---------------------------------------------------------------------------
// Targeted-row emphasis: the row matching action.hash gets BOLD across
// numCol / idCol / title, regardless of action kind.
// ---------------------------------------------------------------------------

describe("renderBlock — targeted row gets BOLD across columns", () => {
  const RED = "\\x1b\\[31m"
  const LIME = "\\x1b\\[38;5;118m"
  // SKY is intentionally omitted: the `started` test below asserts on the
  // idCol's LGRAY+BOLD treatment, not the title's SKY+BOLD (titles are
  // already exercised by the per-status describe block above).
  const LGRAY = "\\x1b\\[38;5;246m"
  const BOLD = "\\x1b\\[1m"
  const STRIKE = "\\x1b\\[9m"
  const RESET = "\\x1b\\[0m"
  const nonEsc = "[^\\x1b]*?"

  test("marked_done: the targeted done row is LIME+BOLD+STRIKE (not DIM+STRIKE)", () => {
    // Two done rows; only #aaaaaa is the target. Non-target stays dim.
    const t1 = task({ id: "aaaaaa", status: "done", title: "just finished" })
    const t2 = task({ id: "bbbbbb", status: "done", title: "older done" })
    const out = renderBlock([topView(t1, 1), topView(t2, 2)], stats({ total: 2, done: 2 }), {
      ansi: true,
      action: { kind: "marked_done", hash: "aaaaaa" },
    })
    // Targeted title: lime + bold + strike, all three present in the
    // same SGR group (no intervening reset).
    expect(out).toMatch(
      new RegExp(LIME + BOLD + STRIKE + nonEsc + "just finished" + nonEsc + RESET),
    )
    // Non-target keeps the dim-strike treatment (no LIME).
    expect(out).not.toMatch(
      new RegExp(LIME + BOLD + STRIKE + nonEsc + "older done" + nonEsc + RESET),
    )
  })

  test("marked_canceled: the targeted canceled row is RED+BOLD+STRIKE", () => {
    const t1 = task({ id: "aaaaaa", status: "canceled", title: "just canceled" })
    const t2 = task({ id: "bbbbbb", status: "canceled", title: "older cancel" })
    const out = renderBlock([topView(t1, 1), topView(t2, 2)], stats({ total: 2, canceled: 2 }), {
      ansi: true,
      action: { kind: "marked_canceled", hash: "aaaaaa" },
    })
    expect(out).toMatch(new RegExp(RED + BOLD + STRIKE + nonEsc + "just canceled" + nonEsc + RESET))
    // Non-target is RED+STRIKE without BOLD.
    expect(out).not.toMatch(
      new RegExp(RED + BOLD + STRIKE + nonEsc + "older cancel" + nonEsc + RESET),
    )
  })

  test("added: the targeted todo row's title gets BOLD (plain → bold)", () => {
    const t1 = task({ id: "aaaaaa", status: "todo", title: "just added" })
    const t2 = task({ id: "bbbbbb", status: "todo", title: "older todo" })
    const out = renderBlock([topView(t1, 1), topView(t2, 2)], stats({ total: 2, todo: 2 }), {
      ansi: true,
      action: { kind: "added", hash: "aaaaaa" },
    })
    // Targeted title is BOLD (no color); non-target stays plain.
    expect(out).toMatch(new RegExp(BOLD + nonEsc + "just added" + nonEsc + RESET))
    // Non-target row has the title text not wrapped in BOLD.
    expect(out).toContain("older todo")
  })

  test("started: the targeted doing row's idCol is LGRAY+BOLD (titles match)", () => {
    // Two doing rows (parallel mode). Titles are both SKY+BOLD —
    // distinction comes from the id column being brighter on target.
    const t1 = task({ id: "aaaaaa", status: "doing", title: "now starting" })
    const t2 = task({ id: "bbbbbb", status: "doing", title: "earlier doing" })
    const out = renderBlock([topView(t1, 1), topView(t2, 2)], stats({ total: 2, doing: 2 }), {
      ansi: true,
      action: { kind: "started", hash: "aaaaaa" },
    })
    // Targeted id col: LGRAY+BOLD around #aaaaaa.
    expect(out).toMatch(new RegExp(LGRAY + BOLD + nonEsc + "#aaaaaa" + nonEsc + RESET))
    // Non-target id col stays DGRAY (no LGRAY+BOLD on #bbbbbb).
    expect(out).not.toMatch(new RegExp(LGRAY + BOLD + nonEsc + "#bbbbbb" + nonEsc + RESET))
  })

  test("removed (ghost): targeted tombstone is RED+BOLD+STRIKE", () => {
    const t = task({ id: "aaaaaa", status: "done", title: "just removed" })
    const out = renderBlock(
      [{ task: t, n: 1, childIndex: null, siblingCount: null, ghost: "removed" } as View],
      stats({ total: 0 }),
      { ansi: true, action: { kind: "removed", hash: "aaaaaa" } },
    )
    expect(out).toMatch(new RegExp(RED + BOLD + STRIKE + nonEsc + "just removed" + nonEsc + RESET))
  })

  test("list / added_many / reordered / cleared / all_done: NO row gets bolded", () => {
    // Bulk / non-targeting actions never highlight a specific row.
    // Use a done row that WOULD pick up LIME+BOLD+STRIKE if targeted.
    const t = task({ id: "aaaaaa", status: "done", title: "definitely not bolded" })
    for (const action of [
      { kind: "list" as const },
      { kind: "added_many" as const, count: 3 },
      { kind: "reordered" as const },
      { kind: "cleared" as const, count: 5 },
      { kind: "all_done" as const },
    ]) {
      const out = renderBlock([topView(t, 1)], stats({ total: 1, done: 1 }), {
        ansi: true,
        action,
      })
      // No LIME+BOLD+STRIKE wrapping the title.
      expect(out).not.toMatch(
        new RegExp(LIME + BOLD + STRIKE + nonEsc + "definitely not bolded" + nonEsc + RESET),
      )
    }
  })

  test("subtask rows honor the targeted flag too", () => {
    // When the targeted hash is a subtask, only that subtask gets
    // bolded — the parent and sibling subtasks stay normal.
    const parent = task({ id: "p00000", status: "doing", title: "parent" })
    const child1 = task({
      id: "p00000a",
      status: "done",
      title: "just-completed child",
      parent: "p00000",
    })
    const child2 = task({
      id: "p00000b",
      status: "done",
      title: "older-completed child",
      parent: "p00000",
    })
    const out = renderBlock(
      [
        topView(parent, 1),
        { task: child1, n: null, childIndex: 0, siblingCount: 2 } as View,
        { task: child2, n: null, childIndex: 1, siblingCount: 2 } as View,
      ],
      stats({ total: 3, done: 2, doing: 1 }),
      { ansi: true, action: { kind: "marked_done", hash: "p00000a" } },
    )
    expect(out).toMatch(
      new RegExp(LIME + BOLD + STRIKE + nonEsc + "just-completed child" + nonEsc + RESET),
    )
    expect(out).not.toMatch(
      new RegExp(LIME + BOLD + STRIKE + nonEsc + "older-completed child" + nonEsc + RESET),
    )
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

  test("ansi: targeted ghost row paints title in RED+BOLD+STRIKE (targeted-row emphasis)", () => {
    // The removed task IS the action's target, so its tombstone gets
    // BOLD on top of the usual RED+STRIKE — "this is the one I just
    // removed". A non-targeted ghost (rare — would come from a bulk
    // remove in a multi-row layout) stays RED+STRIKE without BOLD.
    const b = task({ id: "bbbbbb", title: "beta" })
    const out = renderBlock([ghostView(b, 1)], stats({ total: 0 }), {
      ansi: true,
      action: { kind: "removed", hash: "bbbbbb" },
    })
    const RED = "\\x1b\\[31m"
    const BOLD = "\\x1b\\[1m"
    const STRIKE = "\\x1b\\[9m"
    const RESET = "\\x1b\\[0m"
    const nonEsc = "[^\\x1b]*?"
    // Title wears red+bold+strike (targeted tombstone).
    expect(out).toMatch(new RegExp(RED + BOLD + STRIKE + nonEsc + "beta" + nonEsc + RESET))
    // Icon is red+bold (matches the canceled icon style).
    expect(out).toContain(`\x1b[31m\x1b[1m${GLYPHS.canceled}\x1b[0m`)
    // Id col is dgray+BOLD+strike for the targeted ghost (was DGRAY+STRIKE
    // pre-targeted-emphasis; the BOLD adds visibility to the hash).
    expect(out).toMatch(/\x1b\[38;5;240m\x1b\[1m\x1b\[9m[^\x1b]*?#bbbbbb[^\x1b]*?\x1b\[0m/)
  })

  test("ansi: non-targeted ghost row falls back to RED+STRIKE (no BOLD)", () => {
    // The `removed` action targets a DIFFERENT task; this ghost is
    // collateral (e.g. shown as part of a multi-row layout). Title
    // is RED+STRIKE only — no BOLD escalation.
    const b = task({ id: "bbbbbb", title: "beta" })
    const out = renderBlock([ghostView(b, 1)], stats({ total: 0 }), {
      ansi: true,
      action: { kind: "removed", hash: "ffffff" },
    })
    const RED = "\\x1b\\[31m"
    const BOLD = "\\x1b\\[1m"
    const STRIKE = "\\x1b\\[9m"
    const RESET = "\\x1b\\[0m"
    const nonEsc = "[^\\x1b]*?"
    // RED+STRIKE present...
    expect(out).toMatch(new RegExp(RED + STRIKE + nonEsc + "beta" + nonEsc + RESET))
    // ...but RED+BOLD+STRIKE is NOT.
    expect(out).not.toMatch(new RegExp(RED + BOLD + STRIKE + nonEsc + "beta" + nonEsc + RESET))
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
    const out = renderBlock([ghostView(b, 7)], stats({ total: 0 }), {
      ansi: true,
      action: { kind: "removed", hash: "bbbbbb" },
    })
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
    const out = plain([diffView(t, 1, "old title text")], stats({ total: 1, todo: 1 }), {
      action: { kind: "updated", hash: "abcdef" },
    })
    expect(out).toContain("old title text")
    expect(out).toContain("→")
    expect(out).toContain("new title text")
    // Order matters: old comes before arrow comes before new. Filter to
    // the BODY row specifically — the header also contains `#abcdef`
    // (via the `updated #abcdef` verb), so a naive `find` returns the
    // wrong line.
    const titleRow = out
      .split("\n")
      .find((l) => l.startsWith(GLYPHS.frameML) && l.includes("#abcdef"))!
    expect(titleRow).toBeDefined()
    const oldIdx = titleRow.indexOf("old title")
    const arrowIdx = titleRow.indexOf("→")
    const newIdx = titleRow.indexOf("new title")
    expect(oldIdx).toBeGreaterThanOrEqual(0)
    expect(arrowIdx).toBeGreaterThan(oldIdx)
    expect(newIdx).toBeGreaterThan(arrowIdx)
  })

  test("ansi: old half is RED+STRIKE, new half is SKY+BOLD (update identity)", () => {
    const t = task({ id: "abcdef", status: "doing", title: "new" })
    const out = renderBlock([diffView(t, 1, "old")], stats({ total: 1, doing: 1 }), {
      ansi: true,
      action: { kind: "updated", hash: "abcdef" },
    })
    const RED = "\\x1b\\[31m"
    const STRIKE = "\\x1b\\[9m"
    const SKY = "\\x1b\\[38;5;45m"
    const BOLD = "\\x1b\\[1m"
    const RESET = "\\x1b\\[0m"
    const nonEsc = "[^\\x1b]*?"
    // Old → red+strike around the OLD text.
    expect(out).toMatch(new RegExp(RED + STRIKE + nonEsc + "old" + nonEsc + RESET))
    // New → SKY+BOLD (update action's identity color), regardless of
    // the task's current status. "doing" status alone is also SKY+BOLD
    // now, but the diff overlay hardcodes the color so e.g. a done or
    // canceled task being renamed would still show new-half as SKY+BOLD.
    expect(out).toMatch(new RegExp(SKY + BOLD + nonEsc + "new" + nonEsc + RESET))
  })

  test("ansi: new half is SKY+BOLD even when task is canceled (update identity wins)", () => {
    const t = task({ id: "abcdef", status: "canceled", title: "renamed" })
    const out = renderBlock(
      [diffView(t, 1, "original")],
      stats({ total: 1, canceled: 1, done: 0 }),
      { ansi: true, action: { kind: "updated", hash: "abcdef" } },
    )
    const SKY = "\\x1b\\[38;5;45m"
    const BOLD = "\\x1b\\[1m"
    const RESET = "\\x1b\\[0m"
    const nonEsc = "[^\\x1b]*?"
    expect(out).toMatch(new RegExp(SKY + BOLD + nonEsc + "renamed" + nonEsc + RESET))
  })

  test("diff overlay preserves the closer/status counts (purely visual)", () => {
    const t = task({ id: "abcdef", title: "renamed" })
    const out = plain([diffView(t, 1, "first")], stats({ total: 1, todo: 1 }), {
      action: { kind: "updated", hash: "abcdef" },
    })
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

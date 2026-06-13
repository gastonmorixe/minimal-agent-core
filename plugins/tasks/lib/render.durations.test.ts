import { describe, expect, test } from "bun:test"

import {
  FIXED_NOW_ISO_DATETIME,
  FIXED_NOW_MS,
  plain,
  stats,
  subView,
  task,
  topView,
  withFixedNow,
} from "./render.fixtures.ts"
import { formatDuration, listTotalElapsedMs, renderBlock, taskActiveMs } from "./render.ts"

// ---------------------------------------------------------------------------
// Duration formatting (schema v2)
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  test("< 1s collapses to empty (no flicker for fast ops)", () => {
    expect(formatDuration(0)).toBe("")
    expect(formatDuration(500)).toBe("")
    expect(formatDuration(999)).toBe("")
  })
  test("1s..59s renders as `Ns`", () => {
    expect(formatDuration(1_000)).toBe("1s")
    expect(formatDuration(12_000)).toBe("12s")
    expect(formatDuration(59_999)).toBe("59s")
  })
  test("1m..59m renders as `Mm SSs` with zero-padded seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 00s")
    expect(formatDuration(60_000 + 4_000)).toBe("1m 04s")
    expect(formatDuration(60_000 * 4 + 22_000)).toBe("4m 22s")
    expect(formatDuration(60_000 * 12 + 12_000)).toBe("12m 12s")
  })
  test(">= 1h drops seconds: `Hh MMm`", () => {
    expect(formatDuration(3_600_000)).toBe("1h 00m")
    expect(formatDuration(3_600_000 + 4 * 60_000)).toBe("1h 04m")
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000 + 30_000)).toBe("2h 14m")
  })
  test(">= 24h drops minutes: `Dd HHh`", () => {
    expect(formatDuration(86_400_000)).toBe("1d 00h")
    expect(formatDuration(86_400_000 + 3 * 3_600_000)).toBe("1d 03h")
  })
  test("non-finite input → empty", () => {
    expect(formatDuration(Number.NaN)).toBe("")
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("")
  })
})

// ---------------------------------------------------------------------------
// taskActiveMs — pure per-task duration math
// ---------------------------------------------------------------------------

describe("taskActiveMs", () => {
  const nowMs = new Date(2026, 4, 20, 18, 7, 42).getTime()

  test("non-doing task returns persisted active_ms unchanged", () => {
    const t = task({ status: "done", active_ms: 30_000 })
    expect(taskActiveMs(t, nowMs)).toBe(30_000)
  })

  test("doing task with last_resumed_at adds (now − resumedAt) to active_ms", () => {
    // last_resumed_at = 30s ago, active_ms already accumulated = 12s
    const resumedAt = new Date(nowMs - 30_000).toISOString()
    const t = task({
      status: "doing",
      last_resumed_at: resumedAt,
      active_ms: 12_000,
    })
    expect(taskActiveMs(t, nowMs)).toBe(42_000)
  })

  test("doing task with null last_resumed_at falls back to active_ms (defensive)", () => {
    const t = task({ status: "doing", last_resumed_at: null, active_ms: 8_000 })
    expect(taskActiveMs(t, nowMs)).toBe(8_000)
  })

  test("doing task whose last_resumed_at is in the future does NOT go negative", () => {
    // Clock skew / out-of-order writes shouldn't underflow active_ms.
    const futureResumed = new Date(nowMs + 5_000).toISOString()
    const t = task({
      status: "doing",
      last_resumed_at: futureResumed,
      active_ms: 100,
    })
    expect(taskActiveMs(t, nowMs)).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Duration column in row rendering
// ---------------------------------------------------------------------------

describe("renderBlock — trailing duration suffix", () => {
  test("done task with non-zero active_ms shows the duration trailing the title", () => {
    const t = task({
      status: "done",
      title: "first",
      done_at: "2026-05-20T18:00:48-04:00",
      started_at: "2026-05-20T18:00:00-04:00",
      active_ms: 48_000,
    })
    const out = plain([topView(t, 1)], stats({ total: 1, done: 1 }))
    // Duration appears AFTER the title, separated by a 2-space gap.
    expect(out).toContain("first  48s")
    // And NOT in the old between-#hash-and-title middle slot.
    expect(out).not.toContain("    48s  first")
  })

  test("doing task with last_resumed_at ticks live elapsed = active_ms + (now - resumed)", () => {
    // 30s of active_ms accumulated, currently doing for another 12s.
    // Total live elapsed at render = 42s → "in flight  42s" in row.
    const resumedAt = new Date(FIXED_NOW_MS - 12_000).toISOString()
    const t = task({
      status: "doing",
      title: "in flight",
      started_at: resumedAt,
      last_resumed_at: resumedAt,
      active_ms: 30_000,
    })
    const out = plain([topView(t, 1)], stats({ total: 1, doing: 1 }))
    expect(out).toContain("in flight  42s")
  })

  test("todo task omits the duration suffix entirely (row ends at title, no trailing whitespace)", () => {
    const t = task({ status: "todo", title: "x" })
    const out = plain([topView(t, 1)], stats({ total: 1, todo: 1 }))
    // Row ends at the title with no middle whitespace gutter…
    expect(out).toContain(`#a7b3c4  x`)
    // …and no 7-cell padded slot survives anywhere on the row.
    expect(out).not.toContain(`#a7b3c4  ${" ".repeat(7)}  x`)
    expect(out).not.toContain(`x  ${" ".repeat(7)}`)
  })

  test("top-level row sums children's active_ms into its trailing duration", () => {
    // Phase total = parent's own active_ms (0) + sum of children = 12 + 30 = 42s.
    const parent = task({ id: "p11111", title: "Phase", status: "done" })
    const c1 = task({
      id: "p11111a",
      parent: "p11111",
      status: "done",
      active_ms: 12_000,
    })
    const c2 = task({
      id: "p11111b",
      parent: "p11111",
      status: "done",
      active_ms: 30_000,
    })
    const out = plain(
      [topView(parent, 1), subView(c1, 0, 2), subView(c2, 1, 2)],
      stats({ total: 3, done: 3 }),
    )
    // Parent row's title is followed by the summed 42s; each child
    // row carries its own 12s / 30s trailing its title.
    expect(out).toContain("Phase  42s")
    expect(out).toContain("  12s")
    expect(out).toContain("  30s")
  })

  test("ANSI: doing-row duration is SKY+BOLD (matches ◐ icon + title family)", () => {
    const resumedAt = new Date(FIXED_NOW_MS - 5_000).toISOString()
    const t = task({
      status: "doing",
      started_at: resumedAt,
      last_resumed_at: resumedAt,
      active_ms: 0,
    })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, doing: 1 }), {
      ansi: true,
      action: { kind: "started", hash: "a7b3c4" },
      ...withFixedNow(),
    })
    // SKY = \x1b[38;5;45m, BOLD = \x1b[1m
    expect(out).toMatch(/\x1b\[38;5;45m\x1b\[1m[^\x1b]*?5s[^\x1b]*?\x1b\[0m/)
  })

  test("ANSI: done-row duration is LGRAY (informational chrome, quieter than title)", () => {
    const t = task({
      status: "done",
      done_at: "2026-05-20T18:00:30-04:00",
      started_at: "2026-05-20T18:00:00-04:00",
      active_ms: 30_000,
    })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, done: 1 }), {
      ansi: true,
      action: { kind: "marked_done", hash: "a7b3c4" },
      ...withFixedNow(),
    })
    // LGRAY = \x1b[38;5;246m. Match the duration token "30s" inside an LGRAY span.
    expect(out).toMatch(/\x1b\[38;5;246m[^\x1b]*?30s[^\x1b]*?\x1b\[0m/)
  })

  test("ANSI: canceled-row duration is RED+DIM+STRIKE (matches row family)", () => {
    const t = task({
      status: "canceled",
      reason: "redirected",
      started_at: "2026-05-20T18:00:00-04:00",
      active_ms: 15_000,
    })
    const out = renderBlock([topView(t, 1)], stats({ total: 1, canceled: 1 }), {
      ansi: true,
      action: { kind: "marked_canceled", hash: "a7b3c4" },
      ...withFixedNow(),
    })
    // RED + DIM + STRIKE around the duration token. Order is exact: \x1b[31m\x1b[2m\x1b[9m
    expect(out).toMatch(/\x1b\[31m\x1b\[2m\x1b\[9m[^\x1b]*?15s[^\x1b]*?\x1b\[0m/)
  })
})

// ---------------------------------------------------------------------------
// Header date suffix (the chrome the user explicitly approved)
// ---------------------------------------------------------------------------

describe("renderBlock — header date+time suffix", () => {
  test("header ends with ` · YYYY-MM-DD HH:MM:SS` (single-space between date and time)", () => {
    const t = task()
    const out = plain([topView(t, 1)], stats({ total: 1, todo: 1 }))
    const head = out.split("\n")[0]
    // The fixed `now` in withFixedNow() is 2026-05-20 18:07:42.
    expect(head).toContain(`· ${FIXED_NOW_ISO_DATETIME}`)
    // No trailing duplicated date / time.
    expect(head.match(/2026-05-20/g)?.length ?? 0).toBe(1)
    expect(head.match(/18:07:42/g)?.length ?? 0).toBe(1)
  })

  test("date suffix renders regardless of action kind (always-on chrome)", () => {
    const v = topView(task({ status: "done", done_at: "x" }), 1)
    const s = stats({ total: 1, done: 1 })
    for (const action of [
      { kind: "marked_done", hash: "a7b3c4" } as const,
      { kind: "added", hash: "a7b3c4" } as const,
      { kind: "list" } as const,
      { kind: "all_done" } as const,
    ]) {
      const out = plain([v], s, { action })
      expect(out.split("\n")[0]).toContain(FIXED_NOW_ISO_DATETIME)
    }
  })

  test("ANSI: date suffix wears DIM throughout (chrome, not content)", () => {
    const t = task()
    const out = renderBlock([topView(t, 1)], stats({ total: 1, todo: 1 }), {
      ansi: true,
      action: { kind: "list" },
      ...withFixedNow(),
    })
    // DIM = \x1b[2m. The date should be inside a DIM span.
    expect(out).toMatch(/\x1b\[2m[^\x1b]*?2026-05-20 18:07:42[^\x1b]*?\x1b\[0m/)
  })

  test("date suffix advances with the injected `now`", () => {
    const t = task()
    const altNowMs = new Date(2027, 11, 31, 23, 59, 59).getTime()
    const out = renderBlock([topView(t, 1)], stats({ total: 1, todo: 1 }), {
      ansi: false,
      action: { kind: "list" },
      now: () => altNowMs,
    })
    expect(out.split("\n")[0]).toContain("2027-12-31 23:59:59")
  })
})

// ---------------------------------------------------------------------------
// Closer — elapsed snapshot mid-flight, bold-lime total at all-done
// ---------------------------------------------------------------------------

describe("listTotalElapsedMs", () => {
  const nowMs = new Date(2026, 4, 20, 18, 7, 42).getTime()

  test("returns 0 when no task has ever been started", () => {
    expect(listTotalElapsedMs([task()], nowMs)).toBe(0)
  })

  test("returns now − earliest_started_at when any task is still doing", () => {
    const t = task({
      status: "doing",
      started_at: new Date(nowMs - 12 * 60_000 - 12_000).toISOString(), // 12m 12s ago
      last_resumed_at: new Date(nowMs - 5_000).toISOString(),
      active_ms: 0,
    })
    expect(listTotalElapsedMs([t], nowMs)).toBe(12 * 60_000 + 12_000)
  })

  test("returns latest_done_at − earliest_started_at when all are done", () => {
    const t1 = task({
      id: "aaaaaa",
      status: "done",
      started_at: "2026-05-20T18:00:00-04:00",
      done_at: "2026-05-20T18:05:00-04:00",
      active_ms: 300_000,
    })
    const t2 = task({
      id: "bbbbbb",
      status: "done",
      started_at: "2026-05-20T18:02:00-04:00",
      done_at: "2026-05-20T18:12:34-04:00",
      active_ms: 634_000,
    })
    const elapsed = listTotalElapsedMs([t1, t2], nowMs)
    // 18:00:00 → 18:12:34 = 12m 34s.
    expect(formatDuration(elapsed)).toBe("12m 34s")
  })
})

describe("renderBlock — closer elapsed/total", () => {
  test("mid-flight closer appends ` · <elapsed>` after the count summary (LGRAY, not lime)", () => {
    const t1 = task({
      id: "aaaaaa",
      status: "done",
      started_at: new Date(FIXED_NOW_MS - 12 * 60_000 - 12_000).toISOString(),
      done_at: new Date(FIXED_NOW_MS - 10_000).toISOString(),
      active_ms: 12 * 60_000,
    })
    const t2 = task({
      id: "bbbbbb",
      status: "doing",
      started_at: new Date(FIXED_NOW_MS - 12 * 60_000).toISOString(),
      last_resumed_at: new Date(FIXED_NOW_MS - 5_000).toISOString(),
      active_ms: 7_000,
    })
    const out = plain([topView(t1, 1), topView(t2, 2)], stats({ total: 2, done: 1, doing: 1 }))
    const closer = out.trimEnd().split("\n").at(-1)!
    // Whole-list wall-clock = 12m 12s.
    expect(closer).toContain("12m 12s")
    // Mid-flight, ALL DONE celebration is NOT present (we still have 1 doing).
    expect(closer).not.toContain("ALL DONE")
  })

  test("all-done closer renders total in LIME+BOLD (the single celebrated number)", () => {
    const t1 = task({
      id: "aaaaaa",
      status: "done",
      started_at: "2026-05-20T17:55:08-04:00",
      done_at: "2026-05-20T18:00:00-04:00",
      active_ms: 292_000,
    })
    const t2 = task({
      id: "bbbbbb",
      status: "done",
      started_at: "2026-05-20T18:00:30-04:00",
      done_at: "2026-05-20T18:07:42-04:00",
      active_ms: 432_000,
    })
    const out = renderBlock([topView(t1, 1), topView(t2, 2)], stats({ total: 2, done: 2 }), {
      ansi: true,
      action: { kind: "marked_done", hash: "bbbbbb" },
      ...withFixedNow(),
    })
    const lines = out.trimEnd().split("\n")
    const closer = lines.at(-1)!
    // ALL DONE celebration leads.
    expect(closer).toContain("ALL DONE")
    // 17:55:08 → 18:07:42 = 12m 34s wall-clock total.
    expect(closer).toContain("12m 34s")
    // The total wears LIME+BOLD (\x1b[38;5;118m\x1b[1m).
    expect(closer).toMatch(/\x1b\[38;5;118m\x1b\[1m[^\x1b]*?12m 34s[^\x1b]*?\x1b\[0m/)
  })

  test("closer suppresses elapsed entirely when < 1s (no flicker for fast list calls)", () => {
    // Tasks exist but none have been started — listTotalElapsedMs = 0 → suppressed.
    const t = task()
    const out = plain([topView(t, 1)], stats({ total: 1, todo: 1 }))
    const closer = out.trimEnd().split("\n").at(-1)!
    expect(closer).not.toMatch(/\d+s/)
    expect(closer).toContain("1 todo")
  })

  test("user-approved mockup: full all-done block reads cleanly end-to-end (smoke)", () => {
    // Mirrors the mockup the user approved (duration trails the title):
    //
    //   ╭ ○ Tasks · ✔ ALL DONE · 2/2 · 2026-05-20 18:07:42
    //   │
    //   │    1  ✔  #aaaaaa  Phase 1  4m 52s
    //   │    2  ✔  #bbbbbb  Phase 2  7m 12s
    //   │
    //   ╰  ✦ ALL DONE · 2 done · 12m 34s     ← LIME+BOLD total
    const t1 = task({
      id: "aaaaaa",
      status: "done",
      title: "Phase 1",
      started_at: "2026-05-20T17:55:08-04:00",
      done_at: "2026-05-20T18:00:00-04:00",
      active_ms: 292_000,
    })
    const t2 = task({
      id: "bbbbbb",
      status: "done",
      title: "Phase 2",
      started_at: "2026-05-20T18:00:30-04:00",
      done_at: "2026-05-20T18:07:42-04:00",
      active_ms: 432_000,
    })
    const out = plain([topView(t1, 1), topView(t2, 2)], stats({ total: 2, done: 2 }), {
      action: { kind: "all_done" },
    })
    const lines = out.trimEnd().split("\n")
    expect(lines[0]).toContain("ALL DONE")
    expect(lines[0]).toContain("2/2")
    expect(lines[0]).toContain(FIXED_NOW_ISO_DATETIME)
    // Row durations trail the titles.
    expect(out).toContain("Phase 1  4m 52s")
    expect(out).toContain("Phase 2  7m 12s")
    // Closer celebration + total.
    const closer = lines.at(-1)!
    expect(closer).toContain("✦ ALL DONE")
    expect(closer).toContain("2 done")
    expect(closer).toContain("12m 34s")
  })
})

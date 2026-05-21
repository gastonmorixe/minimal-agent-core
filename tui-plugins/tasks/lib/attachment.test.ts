import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { TasksAttachment, renderAttachmentBody } from "./attachment.ts"
import { TaskStore } from "./store.ts"

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

let tmpHome: string
const sid = "attachment-test-sid"

function withRand(ids: readonly string[]): TaskStore {
  let i = 0
  return new TaskStore(sid, {
    home: tmpHome,
    rand: () => {
      const id = ids[i++ % ids.length]
      const buf = Buffer.alloc(3)
      for (let b = 0; b < 3; b++) buf[b] = Number.parseInt(id.slice(b * 2, b * 2 + 2), 16)
      return buf
    },
  })
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "tasks-att-"))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// renderAttachmentBody
// ---------------------------------------------------------------------------

describe("renderAttachmentBody", () => {
  test("returns empty string for empty list", () => {
    expect(renderAttachmentBody([])).toBe("")
  })
  test("renders top-level tasks with 1-indexed positions", () => {
    const s = withRand(["aaaaaa", "bbbbbb", "cccccc"])
    s.add({ title: "first" })
    s.add({ title: "second" })
    s.add({ title: "third" })
    const body = renderAttachmentBody(s.list())
    const lines = body.split("\n")
    expect(lines[0]).toMatch(/^1\s+#aaaaaa\s+todo\s+first$/)
    expect(lines[1]).toMatch(/^2\s+#bbbbbb\s+todo\s+second$/)
    expect(lines[2]).toMatch(/^3\s+#cccccc\s+todo\s+third$/)
  })
  test("subtasks get Na / Nb / Nc positions", () => {
    const s = withRand(["aaaaaa", "bbbbbb"])
    const p = s.add({ title: "parent" })
    s.addMany(["c1", "c2", "c3"], { parent: p.id })
    s.add({ title: "after" })
    const body = renderAttachmentBody(s.list())
    const lines = body.split("\n")
    expect(lines[0]).toMatch(/^1\s+#aaaaaa\s+todo\s+parent$/)
    expect(lines[1]).toMatch(/^1a\s+#aaaaaaa\s+todo\s+c1$/)
    expect(lines[2]).toMatch(/^1b\s+#aaaaaab\s+todo\s+c2$/)
    expect(lines[3]).toMatch(/^1c\s+#aaaaaac\s+todo\s+c3$/)
    expect(lines[4]).toMatch(/^2\s+#bbbbbb\s+todo\s+after$/)
  })
  test("statuses are rendered verbatim", () => {
    const s = withRand(["aaaaaa", "bbbbbb", "cccccc", "dddddd"])
    s.add({ title: "1", status: "done" })
    s.add({ title: "2", status: "doing" })
    s.add({ title: "3", status: "todo" })
    s.add({ title: "4", status: "canceled" })
    const body = renderAttachmentBody(s.list())
    const lines = body.split("\n")
    expect(lines[0]).toContain("done")
    expect(lines[1]).toContain("doing")
    expect(lines[2]).toContain("todo")
    expect(lines[3]).toContain("canceled")
  })
  test("output is plain ASCII (no ANSI sequences)", () => {
    const s = withRand(["aaaaaa"])
    s.add({ title: "x" })
    const body = renderAttachmentBody(s.list())
    // biome-ignore lint/suspicious/noControlCharactersInRegex: testing absence
    expect(body).not.toMatch(/\x1b\[/)
  })
})

// ---------------------------------------------------------------------------
// TasksAttachment.toAttachment / toText
// ---------------------------------------------------------------------------

describe("TasksAttachment", () => {
  test("returns null when sid is null", () => {
    const a = new TasksAttachment(null, { home: tmpHome })
    expect(a.toAttachment()).toBeNull()
    expect(a.toText()).toBeNull()
  })
  test("returns null when sid is empty/whitespace", () => {
    const a1 = new TasksAttachment("", { home: tmpHome })
    const a2 = new TasksAttachment("   ", { home: tmpHome })
    expect(a1.toAttachment()).toBeNull()
    expect(a2.toAttachment()).toBeNull()
  })
  test("returns null when the file is missing (no tasks)", () => {
    const a = new TasksAttachment(sid, { home: tmpHome })
    expect(a.toAttachment()).toBeNull()
  })
  test("returns null when the file is empty", () => {
    // Construct the store but don't add anything — file is empty/missing.
    // Assign to a discard variable so lint doesn't flag `new` for side effects.
    const _store = new TaskStore(sid, { home: tmpHome })
    void _store
    const a = new TasksAttachment(sid, { home: tmpHome })
    expect(a.toAttachment()).toBeNull()
  })
  test("renders the full <ma::tui::tasks> attachment when tasks exist", () => {
    const s = withRand(["aaaaaa"])
    s.add({ title: "hello" })
    const a = new TasksAttachment(sid, { home: tmpHome })
    const text = a.toText()
    expect(text).not.toBeNull()
    expect(text!.startsWith("<ma::tui::tasks ")).toBe(true)
    expect(text!.endsWith("</ma::tui::tasks>")).toBe(true)
    expect(text).toContain(`total="1"`)
    expect(text).toContain(`done="0"`)
    expect(text).toContain(`todo="1"`)
    expect(text).toContain("#aaaaaa")
    expect(text).toContain("hello")
  })
  test("attachment includes summary counts in the opener", () => {
    const s = withRand(["aaaaaa", "bbbbbb", "cccccc"])
    s.add({ title: "1", status: "done" })
    s.add({ title: "2", status: "doing" })
    s.add({ title: "3" })
    const text = new TasksAttachment(sid, { home: tmpHome }).toText()
    expect(text).toContain(`total="3"`)
    expect(text).toContain(`done="1"`)
    expect(text).toContain(`doing="1"`)
    expect(text).toContain(`todo="1"`)
  })
  test("toAttachment returns a ContentBlock with type='text'", () => {
    const s = withRand(["aaaaaa"])
    s.add({ title: "x" })
    const att = new TasksAttachment(sid, { home: tmpHome }).toAttachment()
    expect(att).not.toBeNull()
    expect(att!.type).toBe("text")
  })
  test("attachment uses ma::tui:: prefix (NOT plain tui::)", () => {
    const s = withRand(["aaaaaa"])
    s.add({ title: "x" })
    const text = new TasksAttachment(sid, { home: tmpHome }).toText()
    expect(text!.startsWith("<ma::tui::tasks")).toBe(true)
    // The scanner only matches <tui::, so this distinct prefix won't be
    // misclassified as a model-emitted inline tag.
    expect(text!.startsWith("<tui::")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Duration column in attachment body (schema v2)
// ---------------------------------------------------------------------------

describe("renderAttachmentBody — duration column", () => {
  test("omits the duration column entirely when every task has active_ms === 0", () => {
    // Freshly-added plan: nothing has been started yet. Keep the
    // attachment as compact as possible for the model.
    const s = withRand(["aaaaaa", "bbbbbb"])
    s.add({ title: "first" })
    s.add({ title: "second" })
    const body = renderAttachmentBody(s.list())
    // No `12s` / `1m02s` / etc. patterns.
    expect(body).not.toMatch(/\b\d+s\b/)
    expect(body).not.toMatch(/\b\d+m\d+s\b/)
    // Title still right after the status column.
    expect(body).toContain("todo      first")
    expect(body).toContain("todo      second")
  })

  test("renders an active_ms column when any task has been started", () => {
    // One task with non-zero active_ms → column appears for ALL rows
    // (visually aligned). Zero-duration rows get blanks in the slot.
    const s = withRand(["aaaaaa", "bbbbbb"])
    s.add({ title: "first" })
    s.add({ title: "second" })
    const t = s.list()[0]
    // Pump active_ms via a doing→done cycle. Use a fixed clock.
    const t0 = new Date(2026, 4, 20, 18, 0, 0)
    const t1 = new Date(2026, 4, 20, 18, 0, 12)
    let i = 0
    const ticks = [t0, t1]
    const s2 = new TaskStore(sid, {
      home: tmpHome,
      now: () => ticks[Math.min(i++, ticks.length - 1)],
    })
    s2.setStatus(t.id, "doing") // tick t0
    s2.setStatus(t.id, "done") // tick t1 → +12s active_ms
    const body = renderAttachmentBody(s2.list())
    // First task carries `12s`.
    expect(body).toContain("12s")
    // Second task's duration slot is blank (just spaces), but the title
    // still appears at the same column position as the first row's title.
    const lines = body.split("\n")
    expect(lines).toHaveLength(2)
    // Both row titles align horizontally: locate "first" / "second" and
    // confirm same column offset.
    const firstTitleCol = lines[0].indexOf("first")
    const secondTitleCol = lines[1].indexOf("second")
    expect(secondTitleCol).toBe(firstTitleCol)
  })

  test("duration column widens to fit the longest formatted value", () => {
    // Forge a task with a "1h04m" duration; second task has "5s". The
    // column width is 5 (longest of the two), so 5s pads to "   5s".
    const s = withRand(["aaaaaa", "bbbbbb"])
    s.add({ title: "long" })
    s.add({ title: "short" })
    const tasks = s.list()
    tasks[0].active_ms = 3_600_000 + 4 * 60_000 // 1h04m
    tasks[1].active_ms = 5_000 // 5s
    const body = renderAttachmentBody(tasks)
    // Both formatted variants are present.
    expect(body).toContain("1h04m")
    expect(body).toContain("5s")
    // Right-padded so the title column lines up: locate the start of
    // each row's title and confirm equal offsets.
    const lines = body.split("\n")
    expect(lines[0].indexOf("long")).toBe(lines[1].indexOf("short"))
  })
})

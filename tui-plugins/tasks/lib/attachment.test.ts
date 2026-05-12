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

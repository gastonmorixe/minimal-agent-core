import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { executeTool } from "../tools/tools.ts"

import { buildEditDiff, buildFileDiff, renderUnifiedDiff } from "./diff.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "diff-test-"))
}

// Strip ANSI for assertions on rendered output.
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

describe("buildEditDiff", () => {
  it("emits a hunk with @@ ranges, -/+ lines, and context for a single-line replace", async () => {
    const before = "line1\nline2\nline3\nline4\nline5\n"
    const patch = buildEditDiff("foo.txt", before, "line3", "LINE3", false)
    expect(patch).toContain("--- a/foo.txt")
    expect(patch).toContain("+++ b/foo.txt")
    // 5 lines, change on line 3 with 3 lines context → covers all 5 lines.
    expect(patch).toContain("@@ -1,5 +1,5 @@")
    expect(patch).toContain("-line3")
    expect(patch).toContain("+LINE3")
    expect(patch).toContain(" line2")
    expect(patch).toContain(" line4")
  })

  it("handles multi-line replacements (different old/new line counts)", async () => {
    const before = "a\nb\nc\nd\ne\n"
    const patch = buildEditDiff("x", before, "b\nc\nd", "B\nC", false)
    expect(patch).toContain("-b")
    expect(patch).toContain("-c")
    expect(patch).toContain("-d")
    expect(patch).toContain("+B")
    expect(patch).toContain("+C")
    // old: 5 lines covered, new: 4 lines.
    expect(patch).toMatch(/@@ -1,5 \+1,4 @@/)
  })

  it("emits multiple hunks for replace_all when matches are far apart", async () => {
    const before = Array.from({ length: 30 }, (_, i) =>
      i === 1 ? "needle" : i === 25 ? "needle" : `pad${i}`,
    ).join("\n")
    const patch = buildEditDiff("y", before, "needle", "NEEDLE", true)
    const hunkHeaders = patch.split("\n").filter((l) => l.startsWith("@@"))
    expect(hunkHeaders.length).toBe(2)
    expect(patch).toContain("-needle")
    expect(patch).toContain("+NEEDLE")
  })

  it("returns empty string when oldString is not found", async () => {
    expect(buildEditDiff("z", "hello\n", "missing", "x", false)).toBe("")
  })

  it("handles a partial-line replacement (match not on line boundaries)", async () => {
    const before = "hello world\nfoo bar\n"
    const patch = buildEditDiff("p.txt", before, "world", "WORLD", false)
    expect(patch).toContain("-hello world")
    expect(patch).toContain("+hello WORLD")
  })
})

describe("buildFileDiff", () => {
  it("returns empty string for identical inputs", async () => {
    expect(buildFileDiff("a", "x\ny\n", "x\ny\n")).toBe("")
  })

  it("diffs an added line", async () => {
    const patch = buildFileDiff("a", "x\ny\n", "x\ny\nz\n")
    expect(patch).toContain("+z")
    expect(patch).not.toContain("-x")
  })

  it("diffs a removed line", async () => {
    const patch = buildFileDiff("a", "x\ny\nz\n", "x\nz\n")
    expect(patch).toContain("-y")
  })

  it("diffs a modified line as -/+ pair", async () => {
    const patch = buildFileDiff("a", "x\ny\nz\n", "x\nY\nz\n")
    expect(patch).toContain("-y")
    expect(patch).toContain("+Y")
  })

  it("creates a hunk against empty file (new file)", async () => {
    const patch = buildFileDiff("a", "", "hello\nworld\n")
    expect(patch).toContain("+hello")
    expect(patch).toContain("+world")
    expect(patch).toMatch(/@@ -1,0 \+1,2 @@/)
  })
})

describe("renderUnifiedDiff", () => {
  it("colors +/- lines with the agent's modern lime/pink palette and @@ headers cyan", async () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new"
    const out = renderUnifiedDiff(patch)
    // Modern lime (palette 'addition' / 'success') for +new.
    expect(out).toContain("\x1b[38;5;118m+new")
    // Modern hot pink (palette 'removal' / 'error') for -old — same magenta
    // used on the prompt arrow and "minimal-agent" banner.
    expect(out).toContain("\x1b[38;5;199m-old")
    // Cyan ESC for @@
    expect(out).toContain("\x1b[36m@@")
  })

  it("honors MINIMAL_AGENT_PALETTE env injection", async () => {
    const prev = process.env.MINIMAL_AGENT_PALETTE
    process.env.MINIMAL_AGENT_PALETTE = JSON.stringify({
      addition: "\x1b[38;5;46m",
      removal: "\x1b[38;5;196m",
    })
    try {
      const patch = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new"
      const out = renderUnifiedDiff(patch)
      expect(out).toContain("\x1b[38;5;46m+new")
      expect(out).toContain("\x1b[38;5;196m-old")
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_PALETTE
      else process.env.MINIMAL_AGENT_PALETTE = prev
    }
  })
})

describe("executeTool integration", () => {
  it("Edit returns a colored display field with diff content", async () => {
    const dir = tmp()
    const f = join(dir, "a.txt")
    writeFileSync(f, "alpha\nbeta\ngamma\n")
    try {
      const r = await executeTool("Edit", {
        file_path: f,
        old_string: "beta",
        new_string: "BETA",
      })
      expect(r.is_error).toBeFalsy()
      expect(r.content).toContain("File edited")
      expect(r.display).toBeDefined()
      const plain = stripAnsi(r.display!)
      expect(plain).toContain("-beta")
      expect(plain).toContain("+BETA")
      expect(plain).toContain("@@")
      // Verify modern palette colors (lime / pink) are actually present
      expect(r.display!).toContain("\x1b[38;5;118m+BETA")
      expect(r.display!).toContain("\x1b[38;5;199m-beta")
      expect(readFileSync(f, "utf-8")).toBe("alpha\nBETA\ngamma\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("Write returns a display field for new files", async () => {
    const dir = tmp()
    const f = join(dir, "new.txt")
    try {
      const r = await executeTool("Write", { file_path: f, content: "hi\nthere\n" })
      expect(r.is_error).toBeFalsy()
      expect(r.display).toBeDefined()
      const plain = stripAnsi(r.display!)
      expect(plain).toContain("New file:")
      expect(plain).toContain("+hi")
      expect(plain).toContain("+there")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("Write returns a display field showing diff for overwrites", async () => {
    const dir = tmp()
    const f = join(dir, "existing.txt")
    writeFileSync(f, "one\ntwo\nthree\n")
    try {
      const r = await executeTool("Write", {
        file_path: f,
        content: "one\nTWO\nthree\n",
      })
      const plain = stripAnsi(r.display!)
      expect(plain).toContain("-two")
      expect(plain).toContain("+TWO")
      expect(plain).toContain("Write:")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("Edit with replace_all produces multiple hunks when matches are far apart", async () => {
    const dir = tmp()
    const f = join(dir, "many.txt")
    const lines: string[] = []
    for (let i = 0; i < 40; i++) lines.push(i === 2 || i === 30 ? "TAG" : `l${i}`)
    writeFileSync(f, lines.join("\n") + "\n")
    try {
      const r = await executeTool("Edit", {
        file_path: f,
        old_string: "TAG",
        new_string: "TAGGED",
        replace_all: true,
      })
      expect(r.content).toContain("(2 replacement(s))")
      const headers = stripAnsi(r.display!)
        .split("\n")
        .filter((l) => l.startsWith("@@"))
      expect(headers.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

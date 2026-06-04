import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_LINES } from "./tools/truncation.ts"
import { executeTool, stripInternalFields, type ToolExecResult } from "./tools.ts"

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tools-trunc-"))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("executeTool — universal clamp wiring", () => {
  it("Read on a huge file emits a structured truncation notice with real totals", async () => {
    const path = join(dir, "huge.txt")
    const totalLines = MAX_TOOL_OUTPUT_LINES * 3
    writeFileSync(path, Array.from({ length: totalLines }, (_, i) => `line ${i}`).join("\n"))
    const r = await executeTool("Read", { file_path: path })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("[truncated:")
    expect(r.content).toMatch(new RegExp(`/${totalLines} lines`))
    expect(r.content).toMatch(/call Read with offset=\d+/)
    // Internal field must NOT leak to callers.
    expect((r as unknown as Record<string, unknown>)._truncCtx).toBeUndefined()
  })

  it("Read with offset reports cut line relative to offset", async () => {
    const path = join(dir, "huge2.txt")
    const totalLines = MAX_TOOL_OUTPUT_LINES * 3
    writeFileSync(path, Array.from({ length: totalLines }, (_, i) => `line ${i}`).join("\n"))
    const r = await executeTool("Read", { file_path: path, offset: 200 })
    const m = r.content.match(/cut at byte \d+, line (\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(200)
  })

  it("Read on a small file does NOT emit a notice", async () => {
    const path = join(dir, "small.txt")
    writeFileSync(path, "one\ntwo\nthree\n")
    const r = await executeTool("Read", { file_path: path })
    expect(r.content).not.toContain("[truncated:")
  })

  it("Grep with massive output gets clamped with totals known", async () => {
    const big = join(dir, "grepme.txt")
    writeFileSync(big, "match\n".repeat(MAX_TOOL_OUTPUT_LINES * 3))
    const r = await executeTool("Grep", {
      pattern: "match",
      path: big,
      output_mode: "content",
      head_limit: 0, // disable internal head-limit; rely on universal clamp
    })
    expect(r.content).toContain("[truncated:")
    // Real total, not "unknown".
    expect(r.content).toMatch(/of \d+ bytes/)
    expect(r.content).not.toMatch(/of unknown bytes/)
    expect(r.content).toMatch(/narrow|head_limit/i)
  })

  it("Bash output clamped with known totals (spawnSync buffered)", async () => {
    const r = await executeTool("Bash", {
      command: `yes ABC | head -c ${MAX_TOOL_OUTPUT_BYTES * 2}`,
    })
    expect(r.content).toContain("[truncated:")
    expect(r.content).toMatch(/head -c|sed -n|awk/)
    expect(r.content).toMatch(/of \d+ bytes/)
  })

  it("Edit is NOT clamped — display channel preserved intact", async () => {
    const path = join(dir, "edit.txt")
    writeFileSync(path, "alpha\nbeta\n")
    const r = await executeTool("Edit", {
      file_path: path,
      old_string: "alpha",
      new_string: "ALPHA",
    })
    expect(r.content).not.toContain("[truncated:")
    expect(r.display).toBeDefined()
  })

  it("Write is NOT clamped — display channel preserved intact", async () => {
    const path = join(dir, "write.txt")
    const r = await executeTool("Write", { file_path: path, content: "hi\n" })
    expect(r.content).not.toContain("[truncated:")
    expect(r.display).toBeDefined()
  })

  it("preserves is_error while clamping", async () => {
    const r = await executeTool("Bash", {
      command: `bash -c 'yes BAD | head -c ${MAX_TOOL_OUTPUT_BYTES * 2}; exit 1'`,
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("[truncated:")
  })

  it("small Bash output is not annotated", async () => {
    const r = await executeTool("Bash", { command: "echo hello" })
    expect(r.content.trim()).toBe("hello")
    expect(r.content).not.toContain("[truncated:")
  })
})

describe("executeTool — _raw pre-clamp surface (for blob store)", () => {
  it("populates _raw when the clamp fires (Bash byte cap)", async () => {
    const r = await executeTool("Bash", {
      command: `yes BIG | head -c ${MAX_TOOL_OUTPUT_BYTES * 2}`,
    })
    expect(r.content).toContain("[truncated:")
    expect(r._raw).toBeDefined()
    // _raw is the pre-clamp body. It must be at least as large as the
    // post-clamp content (which still includes the trailing notice).
    expect(r._raw!.length).toBeGreaterThan(r.content.length)
    // Trailing notice must NOT be in the raw body (raw is pre-clamp).
    expect(r._raw!).not.toContain("[truncated:")
  })

  it("populates _raw when the clamp fires (Read line cap)", async () => {
    const path = join(dir, "rawcheck.txt")
    const totalLines = MAX_TOOL_OUTPUT_LINES * 2
    writeFileSync(path, Array.from({ length: totalLines }, (_, i) => `line ${i}`).join("\n"))
    const r = await executeTool("Read", { file_path: path })
    expect(r.content).toContain("[truncated:")
    expect(r._raw).toBeDefined()
    // Pre-clamp body for Read carries the same `cat -n` style prefix.
    // Count lines: should equal totalLines (no clamp on raw).
    expect(r._raw!.split("\n").length).toBeGreaterThanOrEqual(totalLines)
  })

  it("does NOT set _raw when content fits under the cap", async () => {
    const r = await executeTool("Bash", { command: "echo small" })
    expect(r.content).not.toContain("[truncated:")
    expect(r._raw).toBeUndefined()
  })

  it("does NOT set _raw when the executor returns display (Edit/Write)", async () => {
    const path = join(dir, "raw-edit.txt")
    writeFileSync(path, "x\n")
    const r = await executeTool("Edit", {
      file_path: path,
      old_string: "x",
      new_string: "y",
    })
    expect(r.display).toBeDefined()
    expect(r._raw).toBeUndefined()
  })

  it("stripInternalFields removes _raw alongside _truncInfo and _aborted", () => {
    const r: ToolExecResult = {
      content: "ok",
      _raw: "pre-clamp body",
      _truncInfo: { tool: "Bash", truncated: false, shownBytes: 2, shownLines: 1, cutLine: 1 },
      _aborted: false,
    }
    stripInternalFields(r)
    expect(r._raw).toBeUndefined()
    expect(r._truncInfo).toBeUndefined()
    expect(r._aborted).toBeUndefined()
  })
})

describe("executeTool — whitespace-confusable path self-heal", () => {
  it("Read heals a plain space requested against a U+202F on-disk name", async () => {
    // On-disk name carries U+202F (macOS screenshot); the request uses a
    // plain ASCII space (the confusable normalization that causes ENOENT).
    const onDisk = join(dir, "Screenshot at 5.49.35\u202fPM.png")
    writeFileSync(onDisk, "pixels\n")
    const requested = join(dir, "Screenshot at 5.49.35 PM.png") // plain space
    const r = await executeTool("Read", { file_path: requested })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("whitespace mismatch")
    expect(r.content).toContain("pixels")
  })

  it("Read still errors when no confusable sibling exists", async () => {
    const r = await executeTool("Read", { file_path: join(dir, "truly-absent.png") })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("Read error")
  })

  it("Read does not heal when two siblings fold to the same name (ambiguous)", async () => {
    const sub = mkdtempSync(join(dir, "ambig-"))
    writeFileSync(join(sub, "a\u202fb.png"), "one\n")
    writeFileSync(join(sub, "a\u00a0b.png"), "two\n")
    const r = await executeTool("Read", { file_path: join(sub, "a b.png") })
    expect(r.is_error).toBe(true)
  })

  it("Edit heals a U+202F on-disk name addressed with a plain space", async () => {
    const onDisk = join(dir, "edit 1.23\u202fPM.txt")
    writeFileSync(onDisk, "alpha\n")
    const r = await executeTool("Edit", {
      file_path: join(dir, "edit 1.23 PM.txt"), // plain space
      old_string: "alpha",
      new_string: "beta",
    })
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(onDisk, "utf-8")).toContain("beta")
  })
})

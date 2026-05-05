import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeTool } from "./tools.ts"
import { MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_LINES } from "./tools/truncation.ts"

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

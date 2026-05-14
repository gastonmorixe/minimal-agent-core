/**
 * Tests for the Grep tool's count-header behavior (Bug 4 fix, May 2026).
 *
 * For `files_with_matches` mode, the tool now prepends a `"N file(s) matched\n"`
 * header so a single-hit result (where the body is just one path) is
 * unambiguous and cannot be misread as a tautological echo of the search
 * scope. 0-match returns `"No matches found."` (unchanged). Content and
 * count modes are left alone because their body shapes are already
 * unambiguous (`path:line:text` / `path:count`).
 *
 * Kept in a dedicated test file (not src/tools.test.ts) to avoid touching
 * files a peer agent may concurrently be editing in a shared worktree.
 *
 * @module tools-grep-count.test
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeTool } from "./tools.ts"

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "grep-count-"))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("Grep — files_with_matches count header", () => {
  it("0 matches: returns 'No matches found.' (unchanged)", async () => {
    const f = join(dir, "empty.txt")
    writeFileSync(f, "nothing relevant here\n")
    const r = await executeTool("Grep", {
      pattern: "ZZZ-no-such-token",
      path: f,
      output_mode: "files_with_matches",
    })
    expect(r.content).toBe("No matches found.")
  })

  it("1 match: prepends '1 file matched\\n' before the path", async () => {
    const f = join(dir, "single-hit.txt")
    writeFileSync(f, "alpha\nbeta\nNEEDLE_X\ndelta\n")
    const r = await executeTool("Grep", {
      pattern: "NEEDLE_X",
      path: f,
      output_mode: "files_with_matches",
    })
    expect(r.is_error).toBeFalsy()
    const lines = r.content.split("\n")
    expect(lines[0]).toBe("1 file matched")
    // Second line is the matching path (full or trimmed by rg, just verify
    // it ends with the basename so we don't lock-in absolute-path quirks).
    expect(lines[1]).toMatch(/single-hit\.txt$/)
    // No further content lines for one hit.
    expect(lines.length).toBe(2)
  })

  it("3 matches: prepends '3 files matched\\n' (plural)", async () => {
    const sub = join(dir, "three")
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, "a.txt"), "NEEDLE_Y\n")
    writeFileSync(join(sub, "b.txt"), "NEEDLE_Y\n")
    writeFileSync(join(sub, "c.txt"), "NEEDLE_Y\n")
    const r = await executeTool("Grep", {
      pattern: "NEEDLE_Y",
      path: sub,
      output_mode: "files_with_matches",
    })
    expect(r.is_error).toBeFalsy()
    const lines = r.content.split("\n")
    expect(lines[0]).toBe("3 files matched")
    // 3 path lines after the header. rg sort order isn't guaranteed across
    // filesystems so just count, don't pin the order.
    expect(lines.length).toBe(4)
    const paths = lines.slice(1).sort()
    expect(paths[0]).toMatch(/a\.txt$/)
    expect(paths[1]).toMatch(/b\.txt$/)
    expect(paths[2]).toMatch(/c\.txt$/)
  })

  it("content mode: no count header (unambiguous body)", async () => {
    const f = join(dir, "content-mode.txt")
    writeFileSync(f, "line one\nNEEDLE_Z is here\nline three\n")
    const r = await executeTool("Grep", {
      pattern: "NEEDLE_Z",
      path: f,
      output_mode: "content",
    })
    expect(r.is_error).toBeFalsy()
    // Content mode bodies are `path:line:text` — already unambiguous.
    // Header would be redundant noise.
    expect(r.content.startsWith("1 ")).toBe(false)
    expect(r.content).not.toContain("file matched")
    expect(r.content).toMatch(/NEEDLE_Z is here/)
  })

  it("count mode: no count header prepended (rg -c emits N directly)", async () => {
    const sub = join(dir, "countdir")
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, "x.txt"), "NEEDLE_W\nNEEDLE_W\nNEEDLE_W\n")
    writeFileSync(join(sub, "y.txt"), "NEEDLE_W\n")
    const r = await executeTool("Grep", {
      pattern: "NEEDLE_W",
      path: sub,
      output_mode: "count",
    })
    expect(r.is_error).toBeFalsy()
    // Our prepended header is `<N> files matched`. We MUST NOT add that
    // in count mode — rg's `-c` body shape (`path:N` per file when
    // scanning a directory) is already unambiguous.
    expect(r.content).not.toContain("file matched")
    expect(r.content).not.toContain("files matched")
    // Body shape: `path:count` per file (sort order not guaranteed).
    const lines = r.content.split("\n").sort()
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatch(/x\.txt:3$/)
    expect(lines[1]).toMatch(/y\.txt:1$/)
  })

  it("default mode (files_with_matches) gets the header too", async () => {
    const f = join(dir, "default-mode.txt")
    writeFileSync(f, "NEEDLE_V somewhere\n")
    // output_mode omitted: default is files_with_matches per execGrep.
    const r = await executeTool("Grep", { pattern: "NEEDLE_V", path: f })
    expect(r.is_error).toBeFalsy()
    expect(r.content.split("\n")[0]).toBe("1 file matched")
  })
})

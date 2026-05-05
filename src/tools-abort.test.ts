/**
 * Tests for Phase 1.2 abort/signal plumbing in tools (executeTool + per-tool
 * runners). See `work/plans/abort-quit-rewind.md` §1.2.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeTool, stripInternalFields, type ToolExecResult } from "./tools.ts"

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tools-abort-"))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("executeTool — abort plumbing", () => {
  it("Bash works without a signal (regression)", async () => {
    const r = await executeTool("Bash", { command: "sleep 0.05 && echo hi" })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("hi")
    expect(r._aborted).toBeUndefined()
  })

  it("Bash aborted mid-flight returns _aborted in <3s", async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const t0 = Date.now()
    const r = (await executeTool(
      "Bash",
      { command: "sleep 5" },
      { signal: ac.signal },
    )) as ToolExecResult
    const dt = Date.now() - t0
    expect(r._aborted).toBe(true)
    expect(r.is_error).toBe(true)
    expect(r.content).toBe("tool aborted by user")
    expect(dt).toBeLessThan(3000)
  })

  it("Read with already-aborted signal returns _aborted without IO", async () => {
    const ac = new AbortController()
    ac.abort()
    // Use a path that does not exist — if any IO happened we'd see "Read error".
    const r = (await executeTool(
      "Read",
      { file_path: "/this/path/does/not/exist/xyz" },
      { signal: ac.signal },
    )) as ToolExecResult
    expect(r._aborted).toBe(true)
    expect(r.is_error).toBe(true)
    expect(r.content).toBe("tool aborted by user")
  })

  it("Write with already-aborted signal does not touch the disk", async () => {
    const ac = new AbortController()
    ac.abort()
    const path = join(dir, "must-not-exist.txt")
    const r = (await executeTool(
      "Write",
      { file_path: path, content: "nope" },
      { signal: ac.signal },
    )) as ToolExecResult
    expect(r._aborted).toBe(true)
    // existsSync would create no file — verify with fs:
    const { existsSync } = await import("node:fs")
    expect(existsSync(path)).toBe(false)
  })

  it("Bash abort kills the underlying process (no orphan)", async () => {
    const marker = `marker-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    await executeTool("Bash", { command: `sleep 3 # ${marker}` }, { signal: ac.signal })
    // Give the kernel a moment to reap.
    await new Promise((r) => setTimeout(r, 200))
    const probe = Bun.spawn(["pgrep", "-f", marker], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(probe.stdout).text()
    await probe.exited
    expect(out.trim()).toBe("")
  })

  it("stripInternalFields removes _truncCtx and _aborted", () => {
    const r: ToolExecResult = {
      content: "x",
      _aborted: true,
      _truncCtx: { tool: "Bash" },
    }
    stripInternalFields(r)
    const raw = r as unknown as Record<string, unknown>
    expect(raw._aborted).toBeUndefined()
    expect(raw._truncCtx).toBeUndefined()
    expect(r.content).toBe("x")
  })

  it("_truncCtx is stripped by executeTool but _aborted is preserved for renderer", async () => {
    const ac = new AbortController()
    ac.abort()
    const r = (await executeTool(
      "Read",
      { file_path: "/nope" },
      { signal: ac.signal },
    )) as ToolExecResult
    const raw = r as unknown as Record<string, unknown>
    expect(raw._truncCtx).toBeUndefined()
    expect(raw._aborted).toBe(true)
  })
})

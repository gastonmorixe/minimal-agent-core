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
  it("Bash forwards stdout chunks via onStdout AS THEY ARRIVE (no buffering)", async () => {
    // Critical for live transcript rendering. Without streaming the user
    // sees nothing until the child exits — long-running commands look
    // frozen. We verify by recording the timestamp of each chunk and
    // asserting that the FIRST chunk arrives well before the process
    // would have completed.
    const chunks: { t: number; s: string }[] = []
    const t0 = Date.now()
    const r = await executeTool(
      "Bash",
      {
        command:
          "echo first; sleep 0.4; echo second; sleep 0.4; echo third",
      },
      {
        onStdout: (s) => {
          chunks.push({ t: Date.now() - t0, s })
        },
      },
    )
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("first")
    expect(r.content).toContain("second")
    expect(r.content).toContain("third")
    // At least one chunk must have arrived before the full ~800ms
    // command finished. Specifically the FIRST `echo first` should be
    // visible long before the second sleep.
    const all = chunks.map((c) => c.s).join("")
    expect(all).toContain("first")
    const firstChunkContaining = chunks.find((c) => c.s.includes("first"))
    expect(firstChunkContaining).toBeDefined()
    // First chunk should land within ~300ms of process start — well
    // before total runtime. Generous bound to avoid CI flake.
    expect(firstChunkContaining!.t).toBeLessThan(300)
    // And the LAST chunk should land later than the first (proves
    // chunks really were streamed across time, not delivered in one
    // bundle at the end).
    if (chunks.length >= 2) {
      expect(chunks[chunks.length - 1].t).toBeGreaterThan(firstChunkContaining!.t)
    }
  })

  it("Bash aborted with partial stream pushes [aborted by user] through onStdout", async () => {
    const chunks: string[] = []
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    await executeTool(
      "Bash",
      {
        command: "for i in 1 2 3 4 5 6 7 8 9 10; do echo word-$i; sleep 0.05; done",
      },
      { signal: ac.signal, onStdout: (s) => chunks.push(s) },
    )
    const all = chunks.join("")
    expect(all).toContain("word-1")
    expect(all).toContain("[aborted by user]")
  })

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

  it("Bash aborted with partial stdout surfaces it instead of dropping", async () => {
    // Loop emitting a line every 50ms; abort after ~250ms — we should see
    // a few lines in `content`, not the canned "tool aborted by user".
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 250)
    const r = (await executeTool(
      "Bash",
      {
        command:
          "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do echo word-$i; sleep 0.05; done",
      },
      { signal: ac.signal },
    )) as ToolExecResult
    expect(r._aborted).toBe(true)
    expect(r.is_error).toBe(true)
    // Should contain at least the first emitted line.
    expect(r.content).toContain("word-1")
    // Should carry the [aborted by user] marker.
    expect(r.content).toContain("[aborted by user]")
    // And NOT be the canned empty-aborted string.
    expect(r.content).not.toBe("tool aborted by user")
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

  it("stripInternalFields removes _truncCtx, _truncInfo, and _aborted", () => {
    const r: ToolExecResult = {
      content: "x",
      _aborted: true,
      _truncCtx: { tool: "Bash" },
      _truncInfo: {
        tool: "Bash",
        truncated: false,
        shownBytes: 1,
        shownLines: 1,
        cutLine: 1,
      },
    }
    stripInternalFields(r)
    const raw = r as unknown as Record<string, unknown>
    expect(raw._aborted).toBeUndefined()
    expect(raw._truncCtx).toBeUndefined()
    expect(raw._truncInfo).toBeUndefined()
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

  it("executeTool preserves _truncInfo on a successful (non-aborted) call", async () => {
    const r = (await executeTool("Bash", { command: "echo hi" })) as ToolExecResult
    // Bash exec populates _truncCtx with totals; executeTool replaces it
    // with a structured _truncInfo for the renderer.
    expect(r._truncInfo).toBeDefined()
    expect(r._truncInfo?.truncated).toBe(false)
    expect(r._truncInfo?.shownLines).toBeGreaterThanOrEqual(1)
    // Stripping then leaves the result API-clean.
    stripInternalFields(r)
    expect((r as unknown as Record<string, unknown>)._truncInfo).toBeUndefined()
  })
})

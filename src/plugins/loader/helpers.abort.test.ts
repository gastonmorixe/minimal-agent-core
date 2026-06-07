/**
 * Cancellation contract for subprocess plugin handlers.
 *
 * Bug 3: `invokeSubprocess` used to `await new Response(proc.stdout).text()`
 * and `await proc.exited` WITHOUT ever consulting `ctx.abort`. A handler
 * that ran long (or wedged) could not be canceled: Esc/Ctrl+C fired the
 * turn's AbortSignal, the loader forwarded it to `ctx.abort`, and nothing
 * happened — `dispatch()` never resolved, so the turn never ended and the
 * REPL was effectively frozen until the OS or the manifest timeout
 * eventually reaped the child.
 *
 * The fix: when `ctx.abort` fires, kill the child (process-group kill, like
 * core's execBash) and settle the call promptly instead of waiting on a
 * child that may never exit on its own.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { TUIContext } from "../types.ts"

import { invokeSubprocess } from "./helpers.ts"

/** Write a throwaway executable script and return its absolute path. */
function writeScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ma-subproc-abort-"))
  const path = join(dir, "handler.ts")
  writeFileSync(path, body)
  return path
}

function makeCtx(abort: AbortSignal, packageDir: string): TUIContext {
  return {
    trigger: {
      type: "tool",
      name: "SlowTool",
      input: {},
      tool_use_id: "toolu_slow_1",
    },
    packageDir,
    cwd: packageDir,
    env: { ...process.env, TUI_PLUGIN_PROTOCOL: "1" } as Record<string, string>,
    abort,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    log: () => {},
  } as unknown as TUIContext
}

describe("invokeSubprocess honors ctx.abort (Bug 3)", () => {
  it("settles promptly and does not hang when the signal fires mid-run", async () => {
    // A handler that reads its envelope then sleeps far longer than the
    // test budget. Before the fix, invokeSubprocess would block on this
    // for the full sleep regardless of abort.
    const script = writeScript(
      [
        "const _ = await new Response(Bun.stdin.stream()).text()",
        "await Bun.sleep(60_000)",
        'process.stdout.write("should-never-print")',
      ].join("\n"),
    )
    const ctrl = new AbortController()
    const ctx = makeCtx(ctrl.signal, join(script, ".."))

    const started = Date.now()
    const p = invokeSubprocess(process.execPath, [script], ctx)
    // Fire the abort shortly after dispatch begins.
    setTimeout(() => ctrl.abort(), 100)

    const result = await p
    const elapsed = Date.now() - started

    // Must come back in well under the child's 60s sleep — proving the
    // abort actually terminated the wait rather than letting it run out.
    expect(elapsed).toBeLessThan(5_000)
    // The result is a tool_result marked as an error/aborted (not the
    // child's normal success output, which never had a chance to print).
    expect(result.kind).toBe("tool_result")
    if (result.kind === "tool_result") {
      expect(result.is_error).toBe(true)
      expect(result.content).not.toContain("should-never-print")
    }
  }, 15_000)

  it("already-aborted signal on entry returns immediately without running to completion", async () => {
    const script = writeScript(
      [
        "const _ = await new Response(Bun.stdin.stream()).text()",
        "await Bun.sleep(60_000)",
        'process.stdout.write("should-never-print")',
      ].join("\n"),
    )
    const ctrl = new AbortController()
    ctrl.abort() // already aborted before dispatch
    const ctx = makeCtx(ctrl.signal, join(script, ".."))

    const started = Date.now()
    const result = await invokeSubprocess(process.execPath, [script], ctx)
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(5_000)
    expect(result.kind).toBe("tool_result")
    if (result.kind === "tool_result") {
      expect(result.is_error).toBe(true)
      expect(result.content).not.toContain("should-never-print")
    }
  }, 15_000)
})

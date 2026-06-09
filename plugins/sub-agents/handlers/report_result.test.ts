/**
 * Handler test for `ReportResult`: it must write a valid sentinel to the path in
 * the worker's environment, be a no-op (with an explanation) when no result path
 * is present (a lead called it), and round-trip through the same parser the
 * supervisor probe uses.
 *
 * @module sub-agents/handlers/report_result.test
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"
import { ENV_RESULT_PATH, parseResultDigest } from "../lib/spawn.ts"

import reportResult, { available } from "./report_result.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "report-result-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ctx(input: Record<string, unknown>, env: Record<string, string>): TUIContext {
  return {
    trigger: { type: "tool", name: "ReportResult", input, tool_use_id: "t1" },
    packageDir: "/tmp/fake",
    cwd: "/tmp/fake",
    env,
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
  }
}

async function call(
  input: Record<string, unknown>,
  env: Record<string, string>,
): Promise<TUIResult> {
  return reportResult(ctx(input, env))
}

describe("ReportResult handler", () => {
  it("writes a valid sentinel to the worker's result path and confirms", async () => {
    const resultPath = join(dir, "abc.result.json")
    const res = await call(
      { summary: "found the leak in pool.ts", artifacts: [join(dir, "out.md")] },
      { [ENV_RESULT_PATH]: resultPath },
    )
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") expect(res.is_error).toBeFalsy()
    expect(existsSync(resultPath)).toBe(true)

    // The bytes parse through the SAME validator the supervisor probe uses.
    const digest = parseResultDigest(JSON.parse(readFileSync(resultPath, "utf-8")))
    expect(digest?.short).toBe("found the leak in pool.ts")
    expect(digest?.artifacts).toEqual([join(dir, "out.md")])
  })

  it("prefixes INCOMPLETE: into the sentinel when the worker flags incompletion", async () => {
    const resultPath = join(dir, "x.result.json")
    await call({ summary: "only got halfway", incomplete: true }, { [ENV_RESULT_PATH]: resultPath })
    const digest = parseResultDigest(JSON.parse(readFileSync(resultPath, "utf-8")))
    expect(digest?.short).toMatch(/^INCOMPLETE: /)
  })

  it("is a no-op with an explanation when there is no result path (a LEAD called it)", async () => {
    const res = await call({ summary: "hello" }, {})
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBe(true)
      expect(res.content).toMatch(/sub-agent completion tool|not a sub-agent/i)
    }
  })

  it("rejects a missing summary as a teaching error", async () => {
    const res = await call({}, { [ENV_RESULT_PATH]: join(dir, "y.result.json") })
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBe(true)
      expect(res.content).toMatch(/summary/i)
    }
    // nothing written
    expect(existsSync(join(dir, "y.result.json"))).toBe(false)
  })
})

describe("ReportResult availability predicate", () => {
  it("is available only when the worker's result-path env is present", () => {
    expect(available({ env: { [ENV_RESULT_PATH]: "/x/r.json" }, cwd: "/" })).toBe(true)
    // a lead (no result path) does NOT see the tool
    expect(available({ env: {}, cwd: "/" })).toBe(false)
    // an empty/whitespace value is treated as absent
    expect(available({ env: { [ENV_RESULT_PATH]: "   " }, cwd: "/" })).toBe(false)
  })
})

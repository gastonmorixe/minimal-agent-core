/**
 * Tests for the user status-bar script runner.
 *
 * @module quota-status/script-runner.test
 */

import { describe, expect, it } from "bun:test"

import { runStatusScript } from "./script-runner.ts"

describe("runStatusScript", () => {
  it("returns the first stdout line; receives the JSON payload on stdin", async () => {
    // `cat` echoes stdin (the JSON payload) back to stdout.
    const out = await runStatusScript("cat", { contextWindow: 200000, sid: "abc" })
    expect(out).toBe(JSON.stringify({ contextWindow: 200000, sid: "abc" }))
  })

  it("returns only the FIRST non-empty line", async () => {
    const out = await runStatusScript("printf 'FOOTER LINE\\nignored\\n'", {})
    expect(out).toBe("FOOTER LINE")
  })

  it("returns null on a non-zero exit", async () => {
    expect(await runStatusScript("false", {})).toBeNull()
  })

  it("returns null on empty stdout", async () => {
    expect(await runStatusScript("true", {})).toBeNull()
  })

  it("returns null for an empty / unparseable command", async () => {
    expect(await runStatusScript("", {})).toBeNull()
    expect(await runStatusScript("   ", {})).toBeNull()
  })

  it("returns null on a missing executable (never throws)", async () => {
    expect(await runStatusScript("this-command-does-not-exist-xyz", {})).toBeNull()
  })

  it("returns null immediately when the signal is already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await runStatusScript("cat", {}, ac.signal)).toBeNull()
  })
})

/**
 * The time limit rules of the Bash tool: `resolveBashTimeout`, and the timer
 * of `execBash` through `executeTool`.
 */

import { describe, expect, it } from "bun:test"

import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import { BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS, resolveBashTimeout } from "./bash-timeout.ts"
import * as T from "./tool-result-text.ts"
import { executeTool } from "./tools.ts"

const DEFAULT = { timeoutMs: BASH_DEFAULT_TIMEOUT_MS, clamped: false }

describe("resolveBashTimeout", () => {
  it("pins the default and the maximum", () => {
    expect(BASH_DEFAULT_TIMEOUT_MS).toBe(120_000)
    expect(BASH_MAX_TIMEOUT_MS).toBe(600_000)
  })

  it("gives the default for a missing value", () => {
    expect(resolveBashTimeout(undefined)).toEqual(DEFAULT)
    expect(resolveBashTimeout(null)).toEqual(DEFAULT)
  })

  it("gives the default for 0 and for a negative value: no call runs with no limit", () => {
    expect(resolveBashTimeout(0)).toEqual(DEFAULT)
    expect(resolveBashTimeout(-1)).toEqual(DEFAULT)
    expect(resolveBashTimeout(-600_001)).toEqual(DEFAULT)
  })

  it("gives the default for a value that is not a finite number", () => {
    expect(resolveBashTimeout(Number.NaN)).toEqual(DEFAULT)
    expect(resolveBashTimeout(Number.POSITIVE_INFINITY)).toEqual(DEFAULT)
    expect(resolveBashTimeout("5000")).toEqual(DEFAULT)
    expect(resolveBashTimeout({})).toEqual(DEFAULT)
  })

  it("keeps a value in the range", () => {
    expect(resolveBashTimeout(200)).toEqual({ timeoutMs: 200, clamped: false })
    expect(resolveBashTimeout(1500.5)).toEqual({ timeoutMs: 1500.5, clamped: false })
    expect(resolveBashTimeout(BASH_MAX_TIMEOUT_MS)).toEqual({
      timeoutMs: BASH_MAX_TIMEOUT_MS,
      clamped: false,
    })
  })

  it("decreases a value above the maximum, and says so", () => {
    const max = { timeoutMs: BASH_MAX_TIMEOUT_MS, clamped: true }
    expect(resolveBashTimeout(BASH_MAX_TIMEOUT_MS + 1)).toEqual(max)
    expect(resolveBashTimeout(86_400_000)).toEqual(max)
  })
})

describe.skipIf(!textFixturesPresent())("Bash time limit", () => {
  // Text from the real text plugins, not a core fallback.
  const text = textFixturesPresent() ? fixtureSyntheticTextResolver() : undefined

  it("stops the command at its timeout and tells the model", async () => {
    const t0 = Date.now()
    const r = await executeTool("Bash", { command: "echo start; sleep 5", timeout: 200 }, { text })
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(r.is_error).toBe(true)
    expect(r.content).toBe("start\n[timed out after 200ms]")
  })

  it("the text of a clamped limit names the clamp", () => {
    expect(T.bashTimedOutText(text, 200)).toBe("[timed out after 200ms]")
    expect(T.bashTimedOutText(text, BASH_MAX_TIMEOUT_MS, true)).toBe(
      "[timed out after 600000ms (clamped to the max)]",
    )
  })
})

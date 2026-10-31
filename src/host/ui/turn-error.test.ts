import { describe, expect, it } from "bun:test"

import { ProviderError } from "@minimal-agent/core/plugin-api/llm/errors"
import { stripAnsi } from "@minimal-agent/core/plugin-api/utils/term-width"

import { errorCode, errorHint, formatFatalError, formatTurnError } from "./turn-error.ts"

describe("errorHint / errorCode", () => {
  it("reads hint and code from a ProviderError", () => {
    const err = new ProviderError("free tier blocked", "zen", {
      status: 403,
      hint: "run `ma provider zen login`",
      code: "zen.free_tier_gate",
    })
    expect(err.hint).toBe("run `ma provider zen login`")
    expect(err.code).toBe("zen.free_tier_gate")
    expect(errorHint(err)).toBe("run `ma provider zen login`")
    expect(errorCode(err)).toBe("zen.free_tier_gate")
  })

  it("duck types any thrown object with a string hint", () => {
    const vendored = Object.assign(new Error("boom"), { hint: "try again", code: "x.y" })
    expect(errorHint(vendored)).toBe("try again")
    expect(errorCode(vendored)).toBe("x.y")
    expect(errorHint({ hint: "plain object" })).toBe("plain object")
  })

  it("follows the cause chain", () => {
    const inner = Object.assign(new Error("inner"), { hint: "inner hint" })
    const outer = new Error("outer", { cause: inner })
    expect(errorHint(outer)).toBe("inner hint")
  })

  it("ignores missing, blank, and non-string hints", () => {
    expect(errorHint(new Error("x"))).toBeUndefined()
    expect(errorHint(Object.assign(new Error("x"), { hint: "  " }))).toBeUndefined()
    expect(errorHint(Object.assign(new Error("x"), { hint: 42 }))).toBeUndefined()
    expect(errorHint("a string")).toBeUndefined()
    expect(errorHint(null)).toBeUndefined()
  })
})

describe("formatTurnError", () => {
  it("renders the message line only when there is no hint", () => {
    expect(stripAnsi(formatTurnError(new Error("bad")))).toBe("\n  error bad\n")
  })

  it("renders the hint on its own dim line under the message", () => {
    const err = new ProviderError("free tier blocked", "zen", { hint: "log in first" })
    const out = formatTurnError(err)
    expect(stripAnsi(out)).toBe("\n  error free tier blocked\n        log in first\n")
    expect(out).toContain("\x1b[2m")
  })

  it("keeps a hint on one line", () => {
    const err = Object.assign(new Error("m"), { hint: "a\nb" })
    expect(stripAnsi(formatTurnError(err))).toBe("\n  error m\n        a b\n")
  })
})

describe("formatFatalError", () => {
  it("renders the fatal line, then the hint on its own dim line", () => {
    const err = new ProviderError("free tier blocked", "zen", { hint: "log in first" })
    expect(stripAnsi(formatFatalError(err))).toBe("fatal: free tier blocked\n  log in first")
    expect(formatFatalError(new Error("bad"))).toBe("fatal: bad")
  })
})

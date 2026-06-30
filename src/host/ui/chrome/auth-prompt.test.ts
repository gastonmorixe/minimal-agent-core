import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../../../term-width.ts"

import {
  renderStartupAuthPromptAborted,
  renderStartupAuthPromptIntro,
  renderStartupAuthPromptQuestion,
  renderStartupAuthPromptStarting,
} from "./auth-prompt.ts"

describe("startup auth prompt chrome", () => {
  it("renders missing and stale credential prompts", () => {
    expect(renderStartupAuthPromptIntro("missing", "no token").map(stripAnsi)).toEqual([
      "",
      "  ⮕ Welcome to minimal-agent — you're not signed in yet.",
      "  │ no token",
    ])

    expect(renderStartupAuthPromptIntro("stale", "invalid_grant").map(stripAnsi)).toEqual([
      "",
      "  ⮕ Credentials expired — refresh token rejected.",
      "  │ invalid_grant",
    ])
  })

  it("renders prompt decisions without owning input", () => {
    expect(stripAnsi(renderStartupAuthPromptQuestion(true))).toBe("  │ Sign in now? [Y/n] ")
    expect(stripAnsi(renderStartupAuthPromptQuestion(false))).toBe("  │ Sign in now? [y/N] ")
    expect(renderStartupAuthPromptAborted().map(stripAnsi)).toEqual([
      "  ╰ aborted — run `minimal-agent --login` later to sign in.",
    ])
    expect(renderStartupAuthPromptStarting().map(stripAnsi)).toEqual(["  ╰ starting login…", ""])
  })
})

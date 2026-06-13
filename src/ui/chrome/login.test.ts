import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../../term-width.ts"

import {
  renderApiKeyLoginSuccess,
  renderLoginBanner,
  renderLoginDisplayMessage,
  renderLoginFailure,
  renderLoginRequiresTty,
} from "./login.ts"

describe("login chrome", () => {
  it("renders host-owned login rows", () => {
    expect(renderLoginBanner().map(stripAnsi)).toEqual(["  ⮕ Sign in", "  │"])
    expect(renderLoginRequiresTty().map(stripAnsi).join("\n")).toContain("interactive terminal")
    expect(renderLoginDisplayMessage("hello\nworld").map(stripAnsi)).toEqual([
      "  │ hello",
      "  │ world",
    ])
    expect(renderApiKeyLoginSuccess("test-service").map(stripAnsi).join("\n")).toContain(
      "stored: test-service",
    )
    expect(renderLoginFailure("bad").map(stripAnsi).join("\n")).toContain("Login failed — bad")
  })
})

import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../../../terminal/term-width.ts"

import {
  renderApiKeyLoginSuccess,
  renderLoginBanner,
  renderLoginDisplayMessage,
  renderLoginFailure,
  renderLoginRequiresTty,
  renderOAuthLoginSuccess,
} from "./login.ts"

describe("login chrome", () => {
  it("renders host-owned login rows", () => {
    expect(renderLoginBanner().map(stripAnsi)).toEqual(["  ⮕ Sign in", "  │"])
    expect(renderLoginRequiresTty().map(stripAnsi).join("\n")).toContain("interactive terminal")
    expect(renderLoginDisplayMessage("hello\nworld").map(stripAnsi)).toEqual([
      "  │ hello",
      "  │ world",
    ])
    expect(
      renderApiKeyLoginSuccess("test-service", "provider-a").map(stripAnsi).join("\n"),
    ).toContain("stored: test-service")
    expect(renderLoginFailure("bad").map(stripAnsi).join("\n")).toContain("Login failed — bad")
  })

  it("renders the stored credential name on OAuth success", () => {
    const text = renderOAuthLoginSuccess({
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: Date.parse("2026-09-08T02:35:46Z"),
      scopes: [],
      credentialName: "test-oauth-4",
    })
      .map(stripAnsi)
      .join("\n")
    expect(text).toContain("Login successful")
    expect(text).toContain("stored: test-oauth-4")
  })
})

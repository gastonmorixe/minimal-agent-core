import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../../term-width.ts"

import { formatRelative, renderAuthStatusRows } from "./auth-status.ts"

describe("auth-status chrome", () => {
  it("renders not-logged-in rows", () => {
    const text = renderAuthStatusRows({ credentials: null, now: 1 }).map(stripAnsi).join("\n")
    expect(text).toContain("Auth status")
    expect(text).toContain("not logged in")
    expect(text).toContain("run `minimal-agent --login` to sign in.")
  })

  it("renders api-key auth", () => {
    const text = renderAuthStatusRows({
      credentials: { apiKey: "sk-ant-..." },
      now: 1,
    })
      .map(stripAnsi)
      .join("\n")
    expect(text).toContain("type     api-key")
    expect(text).toContain("logged in via API key")
  })

  it("renders OAuth status with all common fields", () => {
    const now = 1_700_000_000_000
    const text = renderAuthStatusRows({
      credentials: {
        claudeAiOauth: {
          accessToken: "AT",
          refreshToken: "RT",
          expiresAt: now + 8 * 3600_000,
          scopes: ["user:profile", "user:inference"],
          subscriptionType: "max",
          rateLimitTier: "default_claude_max_20x",
        },
        oauthAccount: {
          accountUuid: "abcdef01-2345-6789-abcd-ef0123456789",
          organizationUuid: "11111111-2222-3333-4444-555555555555",
        },
      },
      now,
    })
      .map(stripAnsi)
      .join("\n")

    expect(text).toContain("type     oauth")
    expect(text).toContain("account  abcdef01-2345-6789-abcd-ef0123456789")
    expect(text).toContain("org      11111111-2222-3333-4444-555555555555")
    expect(text).toContain("plan     max")
    expect(text).toContain("default_claude_max_20x")
    expect(text).toContain("scopes   user:profile user:inference")
    expect(text).toContain("refresh  present")
    expect(text).toContain("logged in")
    expect(text).toContain("in 8h")
    expect(text).not.toContain("expired")
  })

  it("flags expired OAuth tokens", () => {
    const now = 1_700_000_000_000
    const text = renderAuthStatusRows({
      credentials: {
        claudeAiOauth: {
          accessToken: "AT",
          refreshToken: "RT",
          expiresAt: now - 60_000,
          scopes: [],
        },
      },
      now,
    })
      .map(stripAnsi)
      .join("\n")
    expect(text).toContain("expired")
    expect(text).toContain("token expired")
  })

  it("renders missing refresh token and malformed credential rows", () => {
    const missingRefresh = renderAuthStatusRows({
      credentials: { claudeAiOauth: { accessToken: "AT", expiresAt: Date.now() + 3600_000 } },
      now: Date.now(),
    })
      .map(stripAnsi)
      .join("\n")
    expect(missingRefresh).toContain("refresh  missing")

    const malformed = renderAuthStatusRows({
      credentials: { claudeAiOauth: { accessToken: "" } },
      now: Date.now(),
    })
      .map(stripAnsi)
      .join("\n")
    expect(malformed).toContain("has no access token")
  })

  it("formats relative durations compactly", () => {
    expect(formatRelative(59_000)).toBe("59s")
    expect(formatRelative(5 * 60_000 + 20_000)).toBe("5m 20s")
    expect(formatRelative(3 * 3600_000 + 12 * 60_000)).toBe("3h 12m")
    expect(formatRelative(4 * 24 * 3600_000 + 6 * 3600_000)).toBe("4d 6h")
  })
})

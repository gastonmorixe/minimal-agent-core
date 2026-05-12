import { describe, expect, it } from "bun:test"
import { renderAuthStatus, runAuthStatusCommand } from "./auth-status.ts"

/**
 * Strip ANSI for stable string assertions. The renderer uses our `c.*`
 * helpers (sky / bold / dim / etc.) which all wrap text in `\x1b[…m`
 * escape sequences; tests don't care which color was used, only the
 * final visible content.
 */
function noAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI is the point
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

function captureOut(): { out: { write: (s: string) => void }; lines: string[]; text(): string } {
  const lines: string[] = []
  return {
    out: { write: (s) => lines.push(s) },
    lines,
    text() {
      return noAnsi(lines.join(""))
    },
  }
}

describe("renderAuthStatus", () => {
  it("reports not-logged-in (and exit code 1) when keychain is empty", async () => {
    const cap = captureOut()
    const code = await runAuthStatusCommand({ read: () => null, output: cap.out })
    expect(code).toBe(1)
    expect(cap.text()).toContain("not logged in")
  })

  it("reports api-key auth when creds.apiKey is set", () => {
    const cap = captureOut()
    const ok = renderAuthStatus({
      read: () => ({ apiKey: "sk-ant-…" }),
      output: cap.out,
    })
    expect(ok).toBe(true)
    expect(cap.text()).toContain("type     api-key")
    expect(cap.text()).toContain("logged in via API key")
  })

  it("renders OAuth status with all common fields", () => {
    const cap = captureOut()
    const now = 1_700_000_000_000
    const ok = renderAuthStatus({
      read: () => ({
        claudeAiOauth: {
          accessToken: "AT",
          refreshToken: "RT",
          expiresAt: now + 8 * 3600_000, // 8h from now
          scopes: ["user:profile", "user:inference"],
          subscriptionType: "max",
          rateLimitTier: "default_claude_max_20x",
        },
        oauthAccount: {
          accountUuid: "abcdef01-2345-6789-abcd-ef0123456789",
          organizationUuid: "11111111-2222-3333-4444-555555555555",
        },
      }),
      output: cap.out,
      now: () => now,
    })
    expect(ok).toBe(true)
    const t = cap.text()
    expect(t).toContain("type     oauth")
    expect(t).toContain("account  abcdef01-2345-6789-abcd-ef0123456789")
    expect(t).toContain("org      11111111-2222-3333-4444-555555555555")
    expect(t).toContain("plan     max")
    expect(t).toContain("default_claude_max_20x")
    expect(t).toContain("scopes   user:profile user:inference")
    expect(t).toContain("refresh  present")
    expect(t).toContain("logged in")
    expect(t).toContain("in 8h") // formatRelative output
    expect(t).not.toContain("expired")
  })

  it("flags an expired token but still returns logged-in (refresh handles it)", () => {
    const cap = captureOut()
    const now = 1_700_000_000_000
    const ok = renderAuthStatus({
      read: () => ({
        claudeAiOauth: {
          accessToken: "AT",
          refreshToken: "RT",
          expiresAt: now - 60_000, // 1 min ago
          scopes: [],
        },
      }),
      output: cap.out,
      now: () => now,
    })
    expect(ok).toBe(true) // stale-but-present is still logged in
    const t = cap.text()
    expect(t).toContain("expired")
    expect(t).toContain("token expired")
  })

  it("reports missing refresh token in yellow", () => {
    const cap = captureOut()
    const ok = renderAuthStatus({
      read: () => ({
        claudeAiOauth: {
          accessToken: "AT",
          // no refreshToken
          expiresAt: Date.now() + 3600_000,
          scopes: [],
        },
      }),
      output: cap.out,
    })
    expect(ok).toBe(true)
    expect(cap.text()).toContain("refresh  missing")
  })

  it("treats keychain-with-no-access-token as not logged in", () => {
    const cap = captureOut()
    const ok = renderAuthStatus({
      read: () => ({ claudeAiOauth: { accessToken: "" } }),
      output: cap.out,
    })
    expect(ok).toBe(false)
    expect(cap.text()).toContain("has no access token")
  })
})

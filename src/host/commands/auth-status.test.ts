import { describe, expect, it } from "bun:test"

import { runAuthStatusCommand } from "./auth-status.ts"

/**
 * Strip ANSI for stable string assertions.
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

describe("runAuthStatusCommand", () => {
  it("reports not-logged-in (and exit code 1) when the credential store is empty", async () => {
    const cap = captureOut()
    const code = await runAuthStatusCommand({
      discover: () => [],
      resolveAuth: () => null,
      output: cap.out,
    })
    expect(code).toBe(1)
    expect(cap.text()).toContain("not logged in")
  })

  it("reports api-key auth when resolved auth returns api key", async () => {
    const cap = captureOut()
    const code = await runAuthStatusCommand({
      discover: () => [
        {
          providerId: "test-provider",
          displayName: "Test Provider",
          authKind: "api-key",
          source: "store",
        },
      ],
      resolveAuth: () => ({ kind: "api-key", key: "sk-ant-…" }),
      output: cap.out,
    })
    expect(code).toBe(0)
    expect(cap.text()).toContain("api-key")
  })

  it("renders OAuth status", async () => {
    const cap = captureOut()
    const code = await runAuthStatusCommand({
      discover: () => [
        {
          providerId: "test-provider",
          displayName: "Test Provider",
          authKind: "oauth",
          source: "store",
        },
      ],
      resolveAuth: () => ({
        kind: "oauth",
        token: "AT",
      }),
      output: cap.out,
      now: () => 1_700_000_000_000,
    })
    expect(code).toBe(0)
    expect(cap.text()).toContain("oauth")
  })

  it("passes provider credential diagnostics through to the renderer", async () => {
    const cap = captureOut()
    const code = await runAuthStatusCommand({
      discover: () => [
        {
          providerId: "test-provider",
          displayName: "Test Provider",
          authKind: "oauth",
          source: "store",
          credentialInfo: {
            usable: true,
            expiresAt: 1_700_000_060_000,
            hasRefreshToken: false,
            accountId: "acct-1",
          },
        },
      ],
      resolveAuth: () => ({
        kind: "oauth",
        token: "AT",
      }),
      output: cap.out,
      now: () => 1_700_000_000_000,
    })

    expect(code).toBe(0)
    expect(cap.text()).toContain("account acct-1")
    expect(cap.text()).toContain("refresh missing")
    expect(cap.text()).not.toContain("AT")
  })
})

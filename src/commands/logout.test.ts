import { describe, expect, it } from "bun:test"
import { runLogoutCommand, stripClaudeJsonOauthAccount } from "./logout.ts"

function captureOut(): { out: { write: (s: string) => void }; text(): string } {
  const lines: string[] = []
  return {
    out: { write: (s) => lines.push(s) },
    text() {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
      return lines.join("").replace(/\x1b\[[0-9;]*m/g, "")
    },
  }
}

describe("stripClaudeJsonOauthAccount", () => {
  it("removes oauthAccount but preserves other fields", () => {
    let written = ""
    const ok = stripClaudeJsonOauthAccount({
      home: "/tmp/fakehome",
      readFile: () =>
        JSON.stringify({
          hasCompletedOnboarding: true,
          firstStartTime: "2024-01-01T00:00:00Z",
          oauthAccount: { accountUuid: "abc", emailAddress: "x@y" },
        }),
      writeFile: (_path, contents) => {
        written = contents
      },
    })
    expect(ok).toBe(true)
    const parsed = JSON.parse(written)
    expect(parsed.oauthAccount).toBeUndefined()
    expect(parsed.hasCompletedOnboarding).toBe(true)
    expect(parsed.firstStartTime).toBe("2024-01-01T00:00:00Z")
  })

  it("returns false when ~/.claude.json doesn't exist", () => {
    const ok = stripClaudeJsonOauthAccount({
      home: "/tmp/fakehome",
      readFile: () => null,
      writeFile: () => {
        throw new Error("should not be called")
      },
    })
    expect(ok).toBe(false)
  })

  it("returns false when oauthAccount field is missing", () => {
    const ok = stripClaudeJsonOauthAccount({
      home: "/tmp/fakehome",
      readFile: () => JSON.stringify({ hasCompletedOnboarding: true }),
      writeFile: () => {
        throw new Error("should not be called")
      },
    })
    expect(ok).toBe(false)
  })

  it("returns false on malformed JSON without throwing", () => {
    const ok = stripClaudeJsonOauthAccount({
      home: "/tmp/fakehome",
      readFile: () => "{not json}",
      writeFile: () => {
        throw new Error("should not be called")
      },
    })
    expect(ok).toBe(false)
  })

  it("returns false when $HOME is empty", () => {
    const ok = stripClaudeJsonOauthAccount({
      home: "",
      readFile: () => "ignored",
      writeFile: () => {
        throw new Error("should not be called")
      },
    })
    expect(ok).toBe(false)
  })
})

describe("runLogoutCommand", () => {
  it("deletes keychain + strips json + reports both", async () => {
    const cap = captureOut()
    let writtenContents = ""
    const code = await runLogoutCommand({
      deleteKeychain: () => true,
      home: "/tmp/fakehome",
      readFile: () =>
        JSON.stringify({
          hasCompletedOnboarding: true,
          oauthAccount: { accountUuid: "abc" },
        }),
      writeFile: (_path, contents) => {
        writtenContents = contents
      },
      output: cap.out,
    })
    expect(code).toBe(0)
    const t = cap.text()
    expect(t).toContain("keychain  removed")
    expect(t).toContain("config    stripped oauthAccount")
    expect(t).toContain("Logged out")
    expect(JSON.parse(writtenContents).oauthAccount).toBeUndefined()
  })

  it("idempotent: no entries to delete still exits 0", async () => {
    const cap = captureOut()
    const code = await runLogoutCommand({
      deleteKeychain: () => false,
      home: "/tmp/fakehome",
      readFile: () => null,
      writeFile: () => {
        throw new Error("should not be called")
      },
      output: cap.out,
    })
    expect(code).toBe(0)
    const t = cap.text()
    expect(t).toContain("(no entry)")
    expect(t).toContain("(nothing to strip)")
  })

  it("doesn't throw when keychain delete throws — degrades gracefully", async () => {
    const cap = captureOut()
    const code = await runLogoutCommand({
      deleteKeychain: () => {
        throw new Error("security tool unavailable")
      },
      home: "/tmp/fakehome",
      readFile: () => null,
      writeFile: () => {},
      output: cap.out,
    })
    expect(code).toBe(0)
    expect(cap.text()).toContain("warn")
    expect(cap.text()).toContain("security tool unavailable")
  })
})

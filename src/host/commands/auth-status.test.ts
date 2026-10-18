import { describe, expect, it } from "bun:test"

import {
  runAuthStatusCommand,
  runAuthStatusPruneCommand,
  runAuthStatusRefreshAllCommand,
  runAuthStatusRefreshCommand,
} from "./auth-status.ts"

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
  it("passes credential names to resolution and keeps unreadable names visible", async () => {
    const cap = captureOut()
    const resolved: Array<[string, string | undefined]> = []
    const code = await runAuthStatusCommand({
      discover: () =>
        ["Work", "Broken"].map((credentialName) => ({
          providerId: "example",
          displayName: "Example",
          authKind: "oauth" as const,
          source: "store" as const,
          credentialName,
          credentialLabel: "Shared label",
        })),
      resolveAuth: (id, name) => {
        resolved.push([id, name])
        return name === "Work" ? { kind: "oauth", token: "secret-token" } : null
      },
      output: cap.out,
    })
    expect(code).toBe(0)
    expect(resolved).toEqual([
      ["example", "Work"],
      ["example", "Broken"],
    ])
    expect(cap.text()).toContain("Example (example)")
    expect(cap.text()).toContain("    Work ✔ oauth\n\n    Broken ✗ oauth credential unreadable")
    expect(cap.text()).not.toContain("Shared label")
    expect(cap.text()).not.toContain("secret-token")
  })

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
    expect(cap.text()).toContain("account: acct-1")
    expect(cap.text()).toContain("refresh: missing")
    expect(cap.text()).not.toContain("AT")
  })

  it("prints the Markdown table with --table", async () => {
    const cap = captureOut()
    const code = await runAuthStatusCommand({
      table: true,
      discover: () => [
        {
          providerId: "example",
          displayName: "Example",
          authKind: "oauth",
          source: "store",
          credentialName: "Work",
          credentialInfo: { usable: true, accountId: "acct-1" },
        },
      ],
      resolveAuth: () => ({ kind: "oauth", token: "secret-token" }),
      output: cap.out,
      now: () => 1_700_000_000_000,
    })
    expect(code).toBe(0)
    expect(cap.text()).toContain("| provider | credential | kind | status |")
    expect(cap.text()).not.toContain("secret-token")
  })

  it("refreshes one credential by name", async () => {
    const cap = captureOut()
    let refreshed = 0
    const code = await runAuthStatusRefreshCommand({
      credential: "Work",
      discover: () => [
        {
          providerId: "example",
          displayName: "Example",
          authKind: "oauth",
          source: "store",
          credentialName: "Work",
        },
      ],
      resolveAuth: () => ({
        kind: "oauth",
        token: "secret-token",
        refresh: async () => {
          refreshed += 1
          return { token: "next" }
        },
      }),
      output: cap.out,
    })
    expect(code).toBe(0)
    expect(refreshed).toBe(1)
    expect(cap.text()).toContain('refreshed "Work"')
    expect(cap.text()).not.toContain("secret-token")
  })

  it("resolves by provider id and reports unreadable auth", async () => {
    const cap = captureOut()
    const code = await runAuthStatusRefreshCommand({
      credential: "example",
      discover: () => [
        {
          providerId: "example",
          displayName: "Example",
          authKind: "oauth",
          source: "store",
          credentialName: "Work",
        },
      ],
      resolveAuth: () => null,
      output: cap.out,
    })
    expect(code).toBe(1)
    expect(cap.text()).toContain("unreadable")
  })

  it("fails when the credential has no refresh hook", async () => {
    const cap = captureOut()
    const code = await runAuthStatusRefreshCommand({
      credential: "Work",
      discover: () => [
        {
          providerId: "example",
          displayName: "Example",
          authKind: "oauth",
          source: "store",
          credentialName: "Work",
        },
      ],
      resolveAuth: () => ({ kind: "oauth", token: "secret-token" }),
      output: cap.out,
    })
    expect(code).toBe(1)
    expect(cap.text()).toContain("refresh not supported")
  })

  it("fails with provider list when a name is ambiguous", async () => {
    const cap = captureOut()
    const code = await runAuthStatusRefreshCommand({
      credential: "Shared",
      discover: () => [
        {
          providerId: "alpha",
          displayName: "Alpha",
          authKind: "oauth",
          source: "store",
          credentialName: "Shared",
        },
        {
          providerId: "beta",
          displayName: "Beta",
          authKind: "oauth",
          source: "store",
          credentialName: "Shared",
        },
      ],
      resolveAuth: () => ({ kind: "oauth", token: "t" }),
      output: cap.out,
    })
    expect(code).toBe(1)
    expect(cap.text()).toContain("ambiguous")
    expect(cap.text()).toContain("alpha")
    expect(cap.text()).toContain("beta")
    expect(cap.text()).toContain("--provider")
  })

  it("disambiguates with --provider", async () => {
    const cap = captureOut()
    let refreshed = 0
    const code = await runAuthStatusRefreshCommand({
      credential: "Shared",
      providerId: "beta",
      discover: () => [
        {
          providerId: "alpha",
          displayName: "Alpha",
          authKind: "oauth",
          source: "store",
          credentialName: "Shared",
        },
        {
          providerId: "beta",
          displayName: "Beta",
          authKind: "oauth",
          source: "store",
          credentialName: "Shared",
        },
      ],
      resolveAuth: (id) => ({
        kind: "oauth",
        token: "t",
        refresh:
          id === "beta"
            ? async () => {
                refreshed += 1
                return { token: "next" }
              }
            : undefined,
      }),
      output: cap.out,
    })
    expect(code).toBe(0)
    expect(refreshed).toBe(1)
  })

  it("refresh-all mixes refreshed, skipped, and failed rows", async () => {
    const cap = captureOut()
    const code = await runAuthStatusRefreshAllCommand({
      parallel: 2,
      now: () => 1_700_000_000_000,
      discover: () => [
        {
          providerId: "fresh",
          displayName: "Fresh",
          authKind: "oauth",
          source: "store",
          credentialName: "F",
          credentialInfo: { usable: true, expiresAt: 1_700_000_000_000 + 3_600_000 },
        },
        {
          providerId: "stale",
          displayName: "Stale",
          authKind: "oauth",
          source: "store",
          credentialName: "S",
          credentialInfo: { usable: true, expiresAt: 1_700_000_000_000 - 60_000 },
        },
        {
          providerId: "keys",
          displayName: "Keys",
          authKind: "api-key",
          source: "store",
          credentialName: "K",
        },
        {
          providerId: "broken",
          displayName: "Broken",
          authKind: "oauth",
          source: "store",
          credentialName: "B",
        },
      ],
      resolveAuth: (id) => {
        if (id === "fresh")
          return {
            kind: "oauth",
            token: "t",
            refresh: async () => ({ token: "n" }),
          }
        if (id === "stale")
          return {
            kind: "oauth",
            token: "t",
            refresh: async () => ({ token: "n" }),
          }
        if (id === "keys") return { kind: "api-key", key: "k" }
        return { kind: "oauth", token: "t", refresh: async () => ({ token: "n" }) }
      },
      output: cap.out,
    })
    const text = cap.text()
    expect(text).toContain("fresh F: skipped-fresh")
    expect(text).toContain("stale S: refreshed")
    expect(text).toContain("keys K: skipped-no-refresh")
    expect(text).toContain("broken B: refreshed")
    expect(code).toBe(0)
  })

  it("refresh-all exits 1 when a refresh fails", async () => {
    const cap = captureOut()
    const code = await runAuthStatusRefreshAllCommand({
      now: () => 1_700_000_000_000,
      discover: () => [
        {
          providerId: "bad",
          displayName: "Bad",
          authKind: "oauth",
          source: "store",
          credentialName: "B",
        },
      ],
      resolveAuth: () => ({
        kind: "oauth",
        token: "t",
        refresh: async () => {
          throw new Error("boom")
        },
      }),
      output: cap.out,
    })
    expect(code).toBe(1)
    expect(cap.text()).toContain("failed boom")
    expect(cap.text()).not.toContain("secret")
  })
})

describe("runAuthStatusPruneCommand", () => {
  const oauthEntry = (over: Record<string, unknown> = {}) => ({
    providerId: "example",
    displayName: "Example",
    authKind: "oauth" as const,
    source: "store" as const,
    credentialName: "Work",
    ...over,
  })

  it("dry run lists dead verdicts without deleting", async () => {
    const cap = captureOut()
    const deleted: Array<[string, string | undefined]> = []
    const code = await runAuthStatusPruneCommand({
      dryRun: true,
      discover: () => [oauthEntry()],
      resolveAuth: () => ({
        kind: "oauth",
        token: "secret-token",
        refresh: async () => {
          throw new Error("invalid_grant: revoked")
        },
      }),
      clearCredentials: (id, _store, name) => {
        deleted.push([id, name])
        return true
      },
      output: cap.out,
    })
    expect(code).toBe(0)
    expect(cap.text()).toContain("example Work: dead")
    expect(deleted).toEqual([])
    expect(cap.text()).not.toContain("secret-token")
  })

  it("force deletes only dead entries in a mixed set", async () => {
    const cap = captureOut()
    const deleted: Array<[string, string | undefined]> = []
    const code = await runAuthStatusPruneCommand({
      force: true,
      discover: () => [
        oauthEntry({ credentialName: "Dead" }),
        oauthEntry({ credentialName: "Live" }),
        oauthEntry({ credentialName: "NoRefresh" }),
      ],
      resolveAuth: (_id, name) => {
        if (name === "Dead")
          return {
            kind: "oauth",
            token: "t",
            refresh: async () => {
              throw new Error("invalid_grant: revoked")
            },
          }
        if (name === "Live")
          return { kind: "oauth", token: "t", refresh: async () => ({ token: "next" }) }
        return { kind: "oauth", token: "t" }
      },
      clearCredentials: (id, _store, name) => {
        deleted.push([id, name])
        return true
      },
      output: cap.out,
    })
    expect(code).toBe(0)
    expect(deleted).toEqual([["example", "Dead"]])
    const text = cap.text()
    expect(text).toContain("example Dead: dead")
    expect(text).toContain("deleted")
    expect(text).toContain("example Live: live")
    expect(text).toContain("example NoRefresh: unknown")
    expect(text).toContain("manual check needed")
  })

  it("fails when neither --dry-run nor --force is given", async () => {
    const cap = captureOut()
    const code = await runAuthStatusPruneCommand({
      discover: () => [oauthEntry()],
      resolveAuth: () => null,
      output: cap.out,
    })
    expect(code).toBe(1)
    expect(cap.text()).toContain("--dry-run")
    expect(cap.text()).toContain("--force")
  })

  it("marks 429 and 5xx API-key probes as unknown and keeps them", async () => {
    const cap = captureOut()
    const deleted: string[] = []
    const failing: Record<string, Error> = {
      Limited: new Error("Models API 429: rate limited"),
      Broken: new Error("Models API 503: unavailable"),
    }
    const code = await runAuthStatusPruneCommand({
      force: true,
      table: true,
      discover: () => [
        {
          providerId: "keys",
          displayName: "Keys",
          authKind: "api-key" as const,
          source: "store" as const,
          credentialName: "Limited",
        },
        {
          providerId: "keys",
          displayName: "Keys",
          authKind: "api-key" as const,
          source: "store" as const,
          credentialName: "Broken",
        },
      ],
      resolveAuth: () => ({ kind: "api-key", key: "sk-ant-secret-key-12" }),
      probeApiKey: async (_id, _auth) => {
        throw failing["Limited"] as Error
      },
      clearCredentials: (id, _store, name) => {
        deleted.push(`${id}/${name}`)
        return true
      },
      output: cap.out,
    })
    expect(code).toBe(0)
    expect(deleted).toEqual([])
    const text = cap.text()
    expect(text).toContain("| provider | credential | kind | verdict | note |")
    expect(text).toContain("unknown")
    expect(text).not.toContain("sk-ant-secret-key-12")
    expect(text).toContain("sk-an…12")
  })

  it("marks 401 API-key probes as dead and deletes with --force", async () => {
    const cap = captureOut()
    const deleted: Array<[string, string | undefined]> = []
    const code = await runAuthStatusPruneCommand({
      force: true,
      discover: () => [
        {
          providerId: "keys",
          displayName: "Keys",
          authKind: "api-key" as const,
          source: "store" as const,
          credentialName: "Old",
        },
      ],
      resolveAuth: () => ({ kind: "api-key", key: "sk-ant-secret-key-12" }),
      probeApiKey: async () => {
        throw new Error("Models API 401: revoked")
      },
      clearCredentials: (id, _store, name) => {
        deleted.push([id, name])
        return true
      },
      output: cap.out,
    })
    expect(code).toBe(0)
    expect(deleted).toEqual([["keys", "Old"]])
    expect(cap.text()).toContain("keys Old: dead")
    expect(cap.text()).toContain("deleted")
    expect(cap.text()).toContain("sk-an…12")
    expect(cap.text()).not.toContain("sk-ant-secret-key-12")
  })

  it("keeps discovery order under a concurrency limit", async () => {
    const cap = captureOut()
    const order: string[] = []
    const entries = ["A", "B", "C", "D", "E", "F"].map((n) => oauthEntry({ credentialName: n }))
    const code = await runAuthStatusPruneCommand({
      dryRun: true,
      parallel: 2,
      discover: () => entries,
      resolveAuth: (_id, name) => ({
        kind: "oauth",
        token: "t",
        refresh: async () => {
          order.push(name as string)
          return { token: "next" }
        },
      }),
      output: cap.out,
    })
    expect(code).toBe(0)
    const lines = cap.text().trim().split("\n")
    expect(lines).toEqual([
      "example A: live",
      "example B: live",
      "example C: live",
      "example D: live",
      "example E: live",
      "example F: live",
    ])
    expect(order.sort()).toEqual(["A", "B", "C", "D", "E", "F"])
  })

  it("exits 1 when a delete fails", async () => {
    const cap = captureOut()
    const code = await runAuthStatusPruneCommand({
      force: true,
      discover: () => [oauthEntry()],
      resolveAuth: () => ({
        kind: "oauth",
        token: "t",
        refresh: async () => {
          throw new Error("invalid_grant: revoked")
        },
      }),
      clearCredentials: () => false,
      output: cap.out,
    })
    expect(code).toBe(1)
    expect(cap.text()).toContain("delete failed")
  })
})
